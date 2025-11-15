# IDEA-Enhanced-Context · Backlog

> 目标：让「IDEA + Milvus + MCP」这条链，从现在的 POC，长成一个可以在 Wushan / Petclinic 上做正式 Show Case 的可用系统（对应文档：
> `doc/idea-enhanced-context-design.md`, `doc/embedding-layer.md`, `doc/idea-bridge-vs-not.md`, `doc/wushan-java-showcase.md`）。

---

## 0. 当前进度快照（2025-11-14）

**已具备能力**

- ✅ IntelliJ Exporter 可以导出模块 / 类的 PSI 信息，并通过 Bridge 上传到 Node 侧缓存（`.idea-bridge/psi-cache.json`）。
- ✅ MCP Server（`mcp-server/`）可以启动，并通过 MCP 暴露：
  - `health_check`
  - `search_java_class`
- ✅ Milvus 中已有两层索引：
  - `indexLevel = "module"`：包含 `repoName / module / modulePath / packages / classCount / springBeans / dependencies / relationSummary / hierarchySummary` 等。
  - `indexLevel = "class"`：包含 `annotations / methods / dependencies.imports / filePath / quality.*`。
- ✅ `search_java_class` 已支持「多阶段」返回结构：
  - `stages[0] = "milvus-module"`：模块级命中，用于 coarse-grained 导航。
  - `stages[1] = "milvus-class"`：类级命中，用于定位入口类等。
- ✅ Petclinic 示例数据已完整入库，可以在 MCP 里检索与 GenAI 模块、vets/visits 服务入口类相关的信息。

**仍然缺失**

- ⏳ 没有显式的「动态 Top-K / staged search 交互 / 上下文预算管理」实现（只是在内部逻辑中做两阶段搜索，未对 MCP 调用方暴露）。
- ⏳ 没有方法级索引（`indexLevel = "method"`）与调用图 / 引用关系（只保留了 summary/占位字段）。
- ⏳ MCP 工具层还只有一个 `search_java_class`，没有更高层的「任务级工具」（比如：找入口服务、查调用链、生成迁移报告）。
- ⏳ 缺少 show case 用的一键 DEMO 流程（特别是 `wushan-java-showcase` 里描绘的场景）。

---

## 1. Milestone A · 巩固现有 POC（「Petclinic 单仓 MVP」）

> 目标：把现在的 Petclinic + Milvus + MCP 搜索，打磨成一个稳定可用的「类/模块搜索服务」，作为后续一切功能的基座。

### A.1 MCP `health_check` 强化

- [x] 扩展 `health_check` 返回结构：
  - [x] `bridge.status`：可连接 / 不可连接，延迟，最近错误。
  - [x] `milvus.status`：可连接 / 不可连接，集合是否存在，向量维度 / indexLevel 字段是否匹配预期。
  - [x] `psiCache.status`：缓存文件存在与否、记录条数、最近更新时间。
- [x] 在 MCP 日志中规范化 health log（统一前缀，例如 `[health]`），方便 CLI / 其他 Agent 抓取。
- [x] 文档：在 `doc/idea-enhanced-context-design.md` 中补一节「Health & Observability」。

### A.2 Milvus 集合与 Schema 固化

- [x] 在 `mcp-server/src/vectordb/` 下加一份 `schema.ts`：
  - [x] 清晰定义 collection 名称、向量字段名、`indexLevel` / `module` / `repoName` / `filePath` 等字段。
  - [x] 提供 `ensureCollectionExists()`，在启动时检查并打印清晰日志，而不是在第一次查询时隐式崩溃。
- [x] 添加一个 `npm script`：`npm run inspect-schema`，打印当前集合 schema，方便调试。
- [x] 文档：在 `doc/embedding-layer.md` 中加入「实际 Schema vs 设计 Schema 对照」小节。

### A.3 PSI Cache 加载与回退逻辑

- [x] 把当前「启动时加载 `.idea-bridge/psi-cache.json`，无缓存时退回 regex index」的逻辑显式整理成一个模块：
  - [x] `psiCache.loadOrFallback()`：返回当前使用的数据源（cache / regex）。
  - [x] 在 `health_check` 和 `search_java_class` 返回体里，附上 `source: "psi-cache" | "regex"`。
- [x] 更新 `doc/idea-bridge-vs-not.md`：
  - [x] 标记当前阶段仍会在「缓存缺失」时使用 regex fallback。
  - [x] 写明未来阶段「IDEA Bridge-only 模式」的目标条件（例如：缓存覆盖率 > 95%，IDEA 插件支持增量推送）。

---

## 2. Milestone B · `search_java_class` → `search_java_symbol`（分阶段检索 + 上下文控制）

> 目标：按照 `doc/embedding-layer.md` 的设计，把「多层索引 + 分阶段搜索 + 上下文预算」真正变成 MCP 工具接口，而不是只作为内部实现。

### B.1 工具输入/输出 Schema 升级

- [ ] 将 MCP 工具从 `search_java_class` 升级为 `search_java_symbol`（保留旧名 alias 以兼容）：
  - 输入：
    - [ ] `query: string`（自然语言或类名）
    - [ ] `preferredLevels?: ("module" | "class" | "method")[]`
    - [ ] `moduleHint?: string`（如 `spring-petclinic-visits-service`）
    - [ ] `maxContextTokens?: number`（建议默认：8000）
  - 输出：
    - [ ] `stages: StageResult[]`（保持现在 `milvus-module` / `milvus-class`，后续加入 `milvus-method`）
    - [ ] 每个命中记录中附带 `estimatedTokens` 与 `scoreHints`（参考 `embedding-layer.md` 的上下文预算策略）。

### B.2 落地「动态 Top-K」策略

- [ ] 在 vectordb 查询层实现 `smartSearch(query, userContext)`：
  - [ ] 简单查询（例如只包含一个类名）使用较小 `top_k` + 只查 `class`。
  - [ ] 复杂查询（包含「调用链」「影响分析」关键词）提高 `top_k`，并查询多层级索引。
- [ ] 根据 `embedding-layer.md` 中的伪代码，将 `indexLevel`/`module`/`filters` 组合成 Milvus 表达式。
- [ ] 在工具返回中暴露 `debug.strategyUsed`，方便调参。

### B.3 实现「上下文预算管理」

- [ ] 在 MCP 内部引入 `ContextBudgetManager`：
  - [ ] 输入：`maxTokens`（来自工具参数或默认值）。
  - [ ] 在累积结果时估算每条记录的 token 数，并智能决定：
    - [ ] 直接附带代码片段（短的）。
    - [ ] 只附带 summary + filePath（长的）。
- [ ] 在工具返回中显示：
  - [ ] `contextBudget: { maxTokens, usedTokens, truncated: boolean }`。
- [ ] 文档：把这个行为与 `doc/embedding-layer.md` 中的「上下文预算管理」章节对齐。

---

## 3. Milestone C · 方法级索引 & 调用关系（为 Wushan Show Case 做准备）

> 目标：为 `doc/wushan-java-showcase.md` 中那种「找出所有调用 WsHttpClient.send 的生产代码」提供技术基础。

### C.1 方法级索引（indexLevel = "method"）

- [ ] 扩展当前 indexing pipeline：
  - [ ] 从 PSI 导出方法级信息（名称、参数、返回值、所在类、修饰符、调用的其它方法、Javadoc）。
  - [ ] 生成适配的 embedding 文本（类 + 方法签名 + Javadoc + 调用关系摘要）。
  - [ ] 写入 Milvus，`indexLevel = "method"`。
- [ ] 更新 schema & ingest 脚本，让 `indexLevel` 支持 `"method"` 并可按模块/类过滤。

### C.2 调用关系 / 引用关系建模

- [ ] 在 PSI Exporter 中增加基本调用关系：
  - [ ] 记录方法调用的 FQN 列表（可简化为字符串数组）。
  - [ ] 记录「该方法被谁调用」的计数（用于排序）。
- [ ] 在 Milvus metadata 中增加：
  - [ ] `callersCount / calleesCount`。
  - [ ] 简单的 `relationSummary`。
- [ ] 为后续「影响分析」类工具预留字段（比如 `framework = "wushan-java"` / `isTestCode`）。

### C.3 MCP 新工具：`analyze_callers_of_method`

- [ ] 新增 MCP 工具：
  - 输入：
    - [ ] `methodFqn: string`（例如 `com.company.ws.WsHttpClient.send`）
    - [ ] `filters?: { excludeTest?: boolean; framework?: string }`
  - 行为：
    - [ ] 在 `indexLevel = "method"` 中检索调用该方法的所有方法/类。
    - [ ] 结合 `module` / `framework` / `isTestCode` 做过滤。
  - 输出：
    - [ ] 对调用者按「在生产代码中」「调用频次」「所属服务」排序的列表。
- [ ] 这是 `wushan-java-showcase` 场景 1 的技术前置条件。

---

## 4. Milestone D · Show Case & 开发体验（Claude / Codex 双模型联动）

> 目标：让「codex 负责开发、Claude Code 负责测试和 bugfix」这套 workflow 落地，并能给别人 demo。

### D.1 Demo 脚本与 README

- [ ] 在仓库新增 `demo/` 目录：
  - [ ] `demo/petclinic-search.md`：演示如何用 MCP 工具在 Petclinic 中查入口类、GenAI 模块。
  - [ ] `demo/wushan-impact-analysis.md`：对应 `wushan-java-showcase` 中的升级影响分析脚本。
- [ ] 在 `README.md` 中加入：
  - [ ] 如何在 Codex CLI 中启用 MCP。
  - [ ] 如何在 Claude Code 中启用同一个 MCP server。
  - [ ] 推荐的「两模型配合」工作流示例：
    - Codex：实现 MCP 新工具 / 改 Milvus pipeline。
    - Claude Code：跑测试 / 探索 search 结果 / 写 bug report。

### D.2 开发体验增强

- [ ] 为 MCP server 增加一个本地开发模式：
  - [ ] 支持 `NODE_OPTIONS=--inspect` 调试。
  - [ ] 提供 `npm run dev`，自动 watch + restart。
- [ ] 补充 VS Code / IntelliJ 的运行配置样例（可选）。

---

## 5. Milestone E · 清理 & 对齐文档

> 目标：让 `doc/*.md` 不再是「理想蓝图」，而是与实现状态同步的设计文档。

- [ ] `doc/idea-bridge-vs-not.md`
  - [ ] 标记已经实现的部分（PSI cache、模块/类级索引）为 ✅。
  - [ ] 对仍依赖 regex fallback 的地方打上 ⚠️。
- [ ] `doc/embedding-layer.md`
  - [ ] 把实际实现的「分阶段搜索 / 动态 Top-K / context budget」细节同步进去。
  - [ ] 用真实的 Milvus schema 示例替代部分伪代码。
- [ ] `doc/idea-enhanced-context-design.md`
  - [ ] 更新架构图，让 MCP 工具列表与当前实现保持一致。
  - [ ] 添加「Plan B 版本」的小结：当前我们支持的是哪一层功能（单仓 / 单语言 / 无增量索引）。

---

## 附录 · Sprint 建议（给人类 PM 和两只猫）

**建议切分：**

- Sprint 1：Milestone A（稳固 POC）  
- Sprint 2：Milestone B（staged search + context budget）  
- Sprint 3：Milestone C（方法级索引 + 调用关系 + analyze_callers_of_method）  
- Sprint 4：Milestone D/E（Show Case + 文档对齐）

每个 Sprint 都可以按「codex 先写功能 → Claude Code 帮忙跑项目内 MR-style review & bugfix → 你做最后验收」的节奏来走。

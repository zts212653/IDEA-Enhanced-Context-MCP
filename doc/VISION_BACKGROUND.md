# IDEA-Enhanced-Context · 愿景与现状背景报告

本页用于对齐“我们要解决什么”“现在做到哪里”“下一步怎么做”，方便团队和大模型一起讨论。

## 愿景：让 LLM + MCP 在大规模 Java/Spring 代码中比 grep 更好用
- 能给出**全景影响面**：修改某个 `Class#method`，能知道上下游哪些模块/类受影响（Spring 生态的 AOP/SPI/反射/配置分散问题也能覆盖）。
- 能做**结构化、可解释的检索**：不仅返回文本匹配，还能展示类型、模块、调用关系、外部系统触达（HTTP/MQ/DB）。
- 用于**代码评审/改动评估**：在看完 PR 改动后，快速问“这次不兼容改动的影响面”，避免漏掉隐式链路。

## 现状（2025-12）
- **数据形态**：PSI 导出的“符号卡片”一条即一行（class/method），包含 FQN、签名、注解、继承、relations、springInfo 等；无 chunk 切分、无 BM25。
- **索引与检索**：
  - Milvus 集合：`idea_symbols_spring_jina`（1024 维，Jina v3）、`idea_symbols_spring_nomic`（3584 维，Nomic）等。
  - 召回：向量检索；排序：规则 boost（roles/moduleHint/callers/callees/infra/Test 惩罚），可选 rerank（默认关，支持本地 MLX v3/Jina API）。
  - 输出：class/method 级结果 + contextBudget 裁剪；已在回归中覆盖 AOP/BPP/事件/WebFlux/JDBC。
- **影响面工具**：
  - `analyze_callers_of_method` / `analyze_callees_of_method`：基于 PSI relations（class 聚合），默认过滤测试；新增回归 Tier3（5 个接口的 callers），阈值较低。
  - `explain_symbol_behavior`：提取 Spring roles/注解/方法签名，返回简要说明。
- **问题**：
  - module 信息在 callers/callees 元数据里缺失或统一为同一个模块，moduleSummary 价值有限。
  - embeddingText 是直接拼接 JSON，信噪比有待提升；同名 getter/setter 容易干扰。
  - Nomic 集合质量/稳定性待验证（曾遇 JSON 解析异常）；默认仍用 Jina。
  - 影响面阈值低，只能证明“工具可用”，不足以支撑“敢不敢改”的决策。

## 我们要解决的核心痛点
1) **“改接口影响面”可信度**：能列出主要调用方/模块/外部系统，减少 Spring 生态下 AOP/SPI/反射/配置分散带来的遗漏。
2) **检索稳定性与语义精度**：同名方法/同构签名多，向量召回需结合类型/注解/模块信息，避免噪声。
3) **模型可拔插与评测**：在不改 schema 的前提下试更好的 embedding/rerank，并有小型评测闭环。

## 近期规划（小步快跑，保持 schema = 1024 维）
1) **补全与清洗数据**（优先）
   - 在 PSI 导出/ingest 时补全 module 信息到 class/method 元数据，更新 moduleSummary。
   - 规范化 embeddingText：固定字段顺序，突出 FQN/签名/类型/注解/继承/模块，截断重复依赖/路径噪声；类级方法签名限量（公共/非 getter/setter 优先）。
2) **模型 A/B（1024 维不改 schema）**
   - 对比：Jina v3（baseline）vs. **jina-code-embeddings-1.5b @1024** vs. **Qwen3-Embedding-4B @1024**（Matryoshka/MRL 输出 1024）。
   - rerank：试 **Qwen3-Reranker-4B**，TopK≈200，rerankK=80/100，规则排序仅 tie-break。
3) **影响面工具增强**
   - `analyze_callers_of_method`/`analyze_callees_of_method`：输出前 N 调用方/被调方示例 + module 分布 + source=calls/references；必要时同时看向上/向下。
   - 用模块信息补全后再提升回归阈值，让“敢不敢改”有更可靠的信号。
4) **轻量规则优化**
   - 在排序层对 query token（方法名、类型、包名、注解、模块）做小权重 boost，压制同名 getter/setter 干扰。

## 中期可能的扩展（需更大改动）
- **双索引**：method 独立行 + class 行，或者开新 collection（bge-code 1536 / Granite 768）做多路召回再 rerank。
- **混合检索**：引入 BM25/关键词通道或 lightweight 关键词 boost。
- **隐式链路增强**：解析 spring.factories / services / ImportSelector / Registrar / @Enable* / META-INF 配置；捕捉反射模式、条件化配置。
- **外部系统映射**：解析事件/MQ/HTTP/DB 配置，影响报告里展示外部触达。
- **报表/解释**：生成“影响面摘要”（模块分布 + 样例调用方 + infra 标记），用于改动评审。

## 当前回归覆盖
- Tier 1/2：方法级索引、AOP/BeanPostProcessor/事件/WebFlux/JDBC 排序质量（Jina 集合，10/10 PASS）。
- Tier 3（新增）：影响面 callers 5 例（阈值低，待模块信息补全后可收紧）。
- 日志：`tmp/milestone-c-tests/`。

## 你可以怎么用 MCP 做“我敢不敢改”
1) `analyze_callers_of_method("FQN#method", excludeTest=true)`：看调用方列表 + 模块分布；若为空或全测试，风险低；若多模块，列前 10。
2) `analyze_callees_of_method("FQN#method")`：看向下依赖/扩展点。
3) `search_java_symbol` 问 “修改 <FQN#method> 会影响什么”，查看 impact profile（callers/callees counts、moduleSummary、libraryRole、HTTP/MQ/DB 标签）。
4) 对关键调用方再跑 callers/callees，逐层圈出 blast radius。未来会补充“影响面摘要”输出以减少手工 drill-down。

## 现有/已运行的服务
- Embedding：Jina v3 本地（1024 维，端口 7997）。
- Rerank：Jina reranker MLX v3 本地服务（端口 7998），可通过 `RERANK_ENABLED=1 RERANK_HOST=http://127.0.0.1:7998` 启用；默认关闭。
- Milvus 集合：`idea_symbols_spring_jina`（1024）、`idea_symbols_spring_nomic`（3584，待验证）、`idea_symbols_petclinic*` 等。

## 讨论重点（带着愿景继续推进）
- 数据信噪：module 信息、隐式链路（AOP/SPI/反射/配置）补强；embeddingText DSL 化。
- 模型实验：在不改 schema 前提下的 1024 维 A/B + rerank 试验闭环。
- 影响面可信度：工具输出要能支撑“敢不敢改”决策，尤其在 Spring 复杂生态下。
- 持续回归：把新增用例（impact 向上/向下）纳入常规验证，模块信息补全后提升阈值。

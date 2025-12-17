# IDEA-Enhanced-Context · Backlog（2025-12-08）

> 愿景：LLM + MCP 比 grep 更好用，能在 Spring 复杂生态里给出可信的影响面（包括 AOP/SPI/反射/配置分散等隐式链路），支撑“敢不敢改”决策。当前按阶段推进，保持现有 schema=1024 和最小改动优先。

---

## 0. 当前快照
- **能力**：method/class 索引；工具 `search_java_symbol`、`analyze_callers_of_method`、`analyze_callees_of_method`、`explain_symbol_behavior`；rerank hook（默认关，支持本地 MLX v3/Jina API）；回归 `scripts/verify-milestone-c.sh --full`（含 Tier3 影响面基线）全部通过。
- **数据**：Milvus 集合 `idea_symbols_spring_jina`(1024)、`idea_symbols`/`idea_symbols_spring_nomic`(3584) 等；Nomic 集合存在但质量未复核。
- **缺口**：callers/callees 的 module 信息缺失，影响面可信度有限；embeddingText 噪声大（JSON 拼接、路径/重复字段）；隐式链路（AOP/SPI/反射/配置）缺少标注；rerank 默认关闭且未有评测对比。

---

## 1. Phase 1（P0，小步可交付，~2 周，保持 1024 schema、不引新 DB）
- [ ] **renderer v2 协议化**：固定字段/顺序，去噪（路径、重复依赖），方法签名限量（public/protected 优先、非 getter/setter 优先），注入 `render_version`/`render_hash`；counts 可留，callers/callees 列表不注入或限量稳定选取。
- [ ] **module 补全**：class/method 元数据与 callers/callees/moduleSummary 补齐（在 Spring Framework/petclinic 覆盖率 ≥95%）。
- [ ] **轻量 token boost**：FQN/类名/方法名/注解/包前缀/模块小权重加分，getter/setter 惩罚；定义并追踪同构噪声率指标。
- [ ] **Embedding/Rerank A/B（1024 维）**：Jina v3 baseline vs `jina-code-embeddings-1.5b@1024` vs `Qwen3-Embedding-4B@1024`；rerank试 `Qwen3-Reranker-4B`，TopK≈200，rerankK=80/100，规则仅 tie-break；指标：Hit@10/NDCG@10、同名噪声率、Top10 稳定性。
- [ ] **影响面输出增强（工具层）**：callers/callees 输出 topN 示例、module 分布、source=calls/references，预留 gaps 字段；新增向下依赖用例；待模块补全后提高 Tier3 阈值。
- [ ] **文档/评测**：记录 renderer v2 协议、A/B 方案与指标；回归脚本更新（含新 impact 阈值）。

---

## 2. Phase 2（P1，~1 个月，隐式链路与可信度）
- [ ] **隐式链路 v1（可确定优先）**：注解 AOP（@Transactional/@Async/@Cacheable/@Scheduled）、@EventListener、SPI/spring.factories/META-INF/services；Conditional 先标记 gap，不做静态求值；反射模式标为软边/gap。
- [ ] **影响面阈值/置信度**：提高 Tier3/Tier4 阈值；输出证据类型分布（CALL/REF/IMPLICIT/GAPS），给出置信度/缺口提示。
- [ ] **可选：Milvus 边表 v1（有限承诺）**：仅写 P0/P1 边（CALL/EVENT/SPI/注解 AOP），REF/IMPORT/反射边强过滤或只做摘要；承诺 1-hop + 小规模 2-hop，分批 IN 查询；边含 src/dst kind/module/repo、edge_key 去重、confidence hint。
- [ ] **评测迭代**：在 A/B 框架下持续对比隐式信号/边表对 Hit@K、噪声率、稳定性的影响。

---

## 3. Phase 3 / 后续（P2+，需另行评估）
- [ ] 进一步的混合检索（BM25/多路召回）、双 collection（bge/Granite 或 method/class 分离），仅在 Phase1/2 收益明确后再定。
- [ ] 更精细的 pointcut 解析、深度图遍历、版本化/多仓图存储，如需超出现有 Milvus 能力时再选型。
- [ ] Demo/Showcase 文档与开发体验增强（参考旧 Milestone D/E）：demo 脚本、IDE 调试配置、文档对齐。

---

## 4. 历史里程碑（归档，已完成的保留供参考）
- Milestone A/B/C：健康检查、schema 固化、`search_java_symbol`、上下文预算、method 索引、callers/callees 工具、Ranking B.1 调优、Milestone C 回归 10/10 PASS。
- Milestone R（部分完成）：rerank hook（env 开关，默认关，支持 Jina/MLX）；其余评测/上线策略待 Phase1/2 落地后决定。

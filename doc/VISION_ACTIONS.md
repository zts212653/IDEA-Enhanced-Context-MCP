# VISION 实施思考（基于 vision-feedback-claude/gpt + 现状约束）

本稿用于吸收外部反馈，结合当前工程状态，筛选“可落地的小步”和“暂缓的大改”。不修改 BACKLOG，供讨论。

## 现状约束（复述）
- 数据：PSI 符号一行向量（class/method），无 chunk，无 BM25；schema=1024（Jina v3），Nomic 集合存在但质量待验证。
- 检索：Milvus 向量召回 + 规则 boost（roles/moduleHint/callers/callees/infra/TEST 惩罚），可选 rerank（默认关，本地 MLX v3 可用）。
- 隐式信息缺口：callers/callees 缺 module，Spring 隐式链路（AOP/SPI/反射/配置）未充分标注。
- 目标：LLM 比 grep 更好，能给出可信的影响面/全景。

## 优先采纳的小步（短期可落地）
1) embeddingText renderer v2（P0）
   - 固定模板/顺序，去噪（路径/重复依赖），突出 FQN/签名/注解/继承/模块/roles/infra 标签；类方法签名限量（public/非 getter/setter 优先）。
   - counts 可保留；callers/callees 列表不注入或限量稳定选取，避免向量漂移。
2) 模型 A/B（保持 1024 维 schema，不动 Milvus）
   - baseline：Jina v3；对比：jina-code-embeddings-1.5b@1024、Qwen3-Embedding-4B@1024（Matryoshka/MRL）。
   - rerank：试 Qwen3-Reranker-4B，TopK≈200，rerankK=80/100，规则层仅 tie-break。
3) module 补全（P0）
   - 将 module 写入 class/method 元数据、callers/callees/moduleSummary，提升影响面可信度；待补全后提高 impact 回归阈值。
4) 轻量 token boost（P0）
   - 对 query token（FQN/类名/方法名/注解/包前缀/模块）小权重加分，getter/setter 惩罚，抑制同名噪声。
5) 影响面工具输出增强（P0）
   - `analyze_callers_of_method`/`analyze_callees_of_method` 输出：前 N 示例、module 分布、source=calls/references；可选 “向上+向下”组合。
   - 在 search/impact profile 结果中增加模块分布/infra 标签/（未来）置信度提示。
6) 隐式链路“可确定优先”（P1 起步）
   - 先做注解驱动 AOP（@Transactional/@Async/@Cacheable/@Scheduled）、@EventListener、SPI/spring.factories/META-INF/services。
   - Conditional 先标记“存在条件”作为 gap/软边，不求静态求值。

## 需谨慎的大步（暂缓或分阶段）
- Milvus 边表方案：可作为 Phase1，但要防止“当图数据库用到死”：
  - 分层或强过滤：CALL/EVENT/SPI/注解 AOP 优先，REF/IMPORT/REFLECTION 可做弱边或只摘要。
  - 只承诺 1-hop/小规模 2-hop；大 IN 列表分批；边做确定性 key/去重；补充 src/dst kind/module/repo、confidence hint。
  - 如未来需要更强图遍历/版本化，不把 “仅 Milvus 边表” 写成永久承诺。
- BM25/混合检索、chunk/overlap：当前范式无文本 chunk/倒排，若引入需重做 ingest/检索，暂缓。
- 全量 pointcut 精解析：优先注解 AOP，execution(..) 先做近似匹配并标记 heuristic，不强行精确。

## 回归与评测建议
- 回归分层：Tier1/2（现有）+ Tier3 影响面（callers/callees，模块信息补全后提高阈值）；可考虑 Tier4 置信度校准（输出 gaps）。
- 小型评测集：AOP/BPP/事件/WebFlux/JDBC/Orders/Petclinic 真实查询，Hit@10/NDCG@10/噪声占比，比较 embedding/rerank 组合。
- 影响面用例：增加“向下”依赖检查；在报告/输出中列出 gaps（反射/条件/SPI 未解析等）。

## “敢不敢改”工作流（对用户/LLM）
1) `analyze_callers_of_method`（excludeTest=true）：看调用方 + 模块分布；为空或全测试风险低。
2) `analyze_callees_of_method`：看向下依赖/扩展点。
3) `search_java_symbol`（impact profile）：查看 callers/callees counts、moduleSummary、infra/libraryRole。
4) 对关键节点再跑 callers/callees，逐层圈出 blast radius；未来可生成“影响面摘要/报告”。

## 后续讨论点
- 是否在 Phase1 就落地 Milvus 边表（CALL/EVENT/SPI/AOP 注解），还是先专注 embeddingText 清洗 + 1024 维模型 A/B + rerank。
- 模块信息补全路径：在 PSI 导出还是 ingest 侧补？（建议 ingest 先补，快见效）
- 影响面阈值：模块信息补全后提高；当前阈值偏低仅作“存在性”检查。

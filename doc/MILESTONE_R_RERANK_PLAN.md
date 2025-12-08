# Milestone R · Rerank 设计草案（Draft）

**状态**：设计稿（未落地代码）  
**分支**：`milestone-r`（by codex pass39）  
**目标**：在现有“向量召回 + 规则/元数据”基础上，引入可插拔 rerank stage，默认关闭、不改变现有行为；为实验提供配置开关、输入特征定义、评测基线与回退策略。

## 1. 现状概览（召回/排序管线）
- 阶段召回：`milvus-method`/`milvus-class`/`milvus-module` + bridge/fallback。
- 规则排序：角色/包名打分、impact profile（callers/callees、HTTP/MQ/DB、moduleHint、TEST 惩罚、moduleSummary）。
- 预算管理：`contextBudget` 在裁剪前已确定输出顺序。
- 需求：在 **不移除现有规则** 的前提下，增加“模型 rerank”（例如 cross-encoder）用于微调前几名的顺序，并保持可回退。

## 2. Rerank 目标与约束
- 默认关闭，行为零变化；开启时仅对“候选子集”重排。
- 输入特征：自然语言 query + 候选文本（summary/fqn/module）+ 关键元数据（roles、callersCount/calleesCount、moduleSummary、libraryRole、indexLevel、kind、source stage）。
- 回退策略：模型失败/超时/无结果 → 使用原排序；失败记录 debug 日志。
- 可插拔：provider/host/model 由 env 控制，便于替换 jina-reranker/bge 等。

## 3. 配置 / Feature Flag（建议）
- `RERANK_ENABLED=0|1`（默认 0）。
- `RERANK_PROVIDER=jina|hf|ollama|openai|custom`（决定请求协议）。
- `RERANK_HOST` / `RERANK_MODEL` / `RERANK_API_KEY`（按 provider 读取）。
- `RERANK_MAX_CANDIDATES`（默认 40；从各 stage 合并去重后截断）。
- `RERANK_TOP_K`（默认 10；仅重排前 K，剩余保持原序）。
- `RERANK_TIMEOUT_MS`（默认 6000；超时即回退）。
- `RERANK_LOG_PROBES=0|1`（记录输入/输出摘要到日志，用于实验对比）。
- 失败处理：任何异常 → 记录一次 warning，继续使用原排序。

## 4. 输入打包（候选 → reranker 文本）
- `query`: 用户原始 query + `preferredLevels/moduleHint` 摘要。
- `doc`: 拼接
  - `fqn` + `summary`
  - `stage`（milvus-method/class/module/fallback）
  - `kind/indexLevel/module/repo`
  - `roles`
  - `callersCount/calleesCount`
  - `moduleSummary`（压成 “module:count, …” 形式，限前 5）
  - `library/libraryRole`（如 http-client/mq-client/db-client/json-serde）
  - `isTest` 标记
- 文本模板保持 ASCII，避免冗长；长度控制在 512-768 tokens 内，超长字段截断。

## 5. 管线插入点（不改默认行为）
1) 现有 staged hits 聚合、规则打分 → 得到 `rankedHits`。  
2) 如果 `RERANK_ENABLED=1`：  
   - 取前 `RERANK_MAX_CANDIDATES`（去重）作为 rerank 输入。  
   - 模型返回分数或排序；用返回顺序替换前 `RERANK_TOP_K`，其余保持原序追加。  
   - 若失败/超时 → 直接使用 `rankedHits`。  
3) 继续走 `applyBudgetStrategy`，保持上下文预算逻辑不变。

## 6. 评测基线与数据集（建议）
- **来源**：沿用 C 阶段回归 + 订单影响场景，确保对“高价值信号”有足够区分度。
- **Queries（建议纳入基线）**  
  - AOP 动态代理（模块 hint: spring-aop）  
  - BeanPostProcessor 测试惩罚（spring-context）  
  - 事件多播（spring-context-event）  
  - WebFlux `ServerResponse#created`（spring-webflux）  
  - JdbcTemplate → RowMapper（spring-jdbc）  
  - Orders 影响面（controller/service/mapper/mq + 多实现 PaymentService）  
  - Petclinic 入口/GenAI 模块（确保多仓/多模块泛化）  
- **度量**：Hit@K(1/3/5/10)、NDCG@10、测试类占比、跨模块覆盖（模块数前 5）。  
- **流程**：  
  1) `RERANK_ENABLED=0` 跑基线（保存 JSON 到 `tmp/rerank-baseline/<query>.json`）。  
  2) `RERANK_ENABLED=1` 跑实验（同目录对照）。  
  3) 简单脚本计算 Hit@K/NDCG + 噪声比（测试/非目标模块）。  
  4) 人工抽查前 5 解释（是否更符合语义/影响面）。

## 7. 实验与上线策略
- **实验**：本地/预发仅设 env，不改代码默认值；日志保留 rerank 输入摘要+耗时。  
- **回退**：任何错误/超时自动回退原排序，结果字段可附 `rerankUsed: boolean`。  
- **上线**：保持默认关闭；若效果确认，可在特定 profile（impact_analysis）先行开启，再扩展到 generic。  
- **成本/延迟**：`RERANK_MAX_CANDIDATES` 与超时时间需平衡（建议 <150ms 模型 + <200ms 网络，否则关闭）。  
  - 当前首选 provider：`jina-reranker-v3-base`（RERANK_PROVIDER=jina），默认 endpoint `https://api.jina.ai/v1/rerank`，支持自定义 host。  
  - 本地自托管（MPS）：`python scripts/jina_reranker_server.py`，可选 `HOST/PORT/MODEL/DEVICE/BATCH_SIZE`。由于 `jina-reranker-v3-base` 需鉴权，本地默认可用 `MODEL=jinaai/jina-reranker-v2-base-multilingual`；启动后配合 `RERANK_HOST=http://127.0.0.1:7998`、`RERANK_MODEL=jinaai/jina-reranker-v2-base-multilingual` 进行测试。

## 8. 后续落地任务（分步骤）
1) 配置读取与 flag 判定（不改变默认行为）。  
2) 抽象 rerank provider 接口 + Jina/HF HTTP 客户端（最小实现）。  
3) 生成 rerank 输入模板（避免过长，含核心元数据）。  
4) 将 rerank hook 注入 `searchPipeline`（guarded by flag）。  
5) 实验脚本：基于现有 `scripts/verify-milestone-c.sh` 复制一份 `scripts/verify-milestone-r.sh`（仅抓 topK，不改行为）。  
6) 记录结果 → 更新本文件和 `AI_CHANGELOG.md`，决定是否在 impact profile 默认开启。

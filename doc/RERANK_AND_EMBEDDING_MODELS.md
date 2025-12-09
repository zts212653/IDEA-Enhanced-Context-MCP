# 模型替换与插拔说明（Embedding / Rerank）

**目的**：说明当前搜索链的模型选项、开关、启动方式，以及更换模型对效果/行为的影响。默认配置保持“可拔插、默认关闭 rerank”。

## 1. Embedding（召回）
- 开关与来源：由 `idea-bridge` 控制，环境变量 `EMBEDDING_PROVIDER/EMBEDDING_HOST/EMBEDDING_MODEL` 决定，ingest 会根据 provider/model 设置向量维度并做 fallback padding。
- 默认：Jina v3（1024 维，host: 127.0.0.1:7997，见 `scripts/jina_server.py`）。
- 替换影响：直接改变 Milvus 召回质量与漂移；维度不匹配会触发 fallback/错误。更换模型后需重新 ingest，并用回归脚本验证。
- 本地启动（示例）：`HOST=127.0.0.1 PORT=7997 MODEL=jinaai/jina-embeddings-v3 DEVICE=mps ./.venv/bin/python scripts/jina_server.py`

## 2. Rerank
- 开关：`RERANK_ENABLED=1|0`（默认 0），`RERANK_PROVIDER=jina|...`，`RERANK_HOST`，`RERANK_MODEL`，`RERANK_API_KEY`，`RERANK_MAX_CANDIDATES`，`RERANK_TOP_K`，`RERANK_TIMEOUT_MS`，`RERANK_LOG_PROBES=1`。
- 行为：只对候选前若干条重排；失败/超时自动回退原排序，`SearchOutcome.rerankUsed` 标记是否生效。
- 远端选项：`RERANK_HOST=https://api.jina.ai/v1/rerank`，`RERANK_MODEL=jina-reranker-v3-base`，需 `RERANK_API_KEY`。

### 2.1 本地 MLX 版（Apple Silicon）
- 位置：`tmp/jina-reranker-v3-mlx`（已下载完整权重，1.1G）。
- 启动：`HOST=127.0.0.1 PORT=7998 MODEL_DIR=$(pwd)/tmp/jina-reranker-v3-mlx nohup ./.venv/bin/python scripts/jina_reranker_mlx_server.py > /tmp/jina_reranker_mlx.log 2>&1 &`
- 健康检查：`curl -s http://127.0.0.1:7998/rerank -H "Content-Type: application/json" -d '{"query":"hello","documents":["a","b"],"top_k":2}'`
- 停止：`lsof -i :7998` 查 PID 后 `kill <pid>`（当前 PID: 45859）。
- 说明：MLX 版来自 `jinaai/jina-reranker-v3-mlx`，不依赖 transformers；默认 device=MPS。

### 2.2 自定义/其他模型
- 若有 HF token 或自有权重，可将 `MODEL_DIR` 指向本地目录（包含 `model.safetensors`、`projector.safetensors`、`rerank.py`）。不需要改代码。
- API 形式：只需改 `RERANK_HOST`/`RERANK_MODEL`/`RERANK_API_KEY`，无需本地模型。

## 3. 影响与验证
- Embedding 更换 → 直接影响召回集合与噪声，需要重新 ingest 并跑 `scripts/verify-milestone-c.sh --full` 或场景回归（AOP/BPP/事件/WebFlux/JDBC/Orders/Petclinic）。
- Rerank 更换 → 仅重排候选，召回不变；建议 A/B 对比 Hit@K/NDCG、测试类占比、跨模块覆盖。可在 `RERANK_ENABLED=0/1` 下各跑一轮并比对 JSON。
- 成本/延迟：本地 MLX 延迟低但单机；远端 API 需注意超时/计费，`RERANK_TIMEOUT_MS` 可控。

## 4. 快速参考（环境变量）
- Embedding：`EMBEDDING_PROVIDER` / `EMBEDDING_HOST` / `EMBEDDING_MODEL`
- Rerank：`RERANK_ENABLED` / `RERANK_PROVIDER` / `RERANK_HOST` / `RERANK_MODEL` / `RERANK_API_KEY` / `RERANK_MAX_CANDIDATES` / `RERANK_TOP_K` / `RERANK_TIMEOUT_MS` / `RERANK_LOG_PROBES`

## 5. 维护建议
- 切换模型前后，务必记录配置与回归结果（Hit@K/NDCG、误报、耗时），并更新 `AI_CHANGELOG.md`。
- 保持本地模型在 `tmp/` 下，避免污染源码树；必要时在 `.gitignore` 确认忽略大文件。

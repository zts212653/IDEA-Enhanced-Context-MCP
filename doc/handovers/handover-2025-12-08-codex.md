# 交接记录 · 2025-12-08 · Codex pass51

## 当前分支 / 工作区
- 分支：`milestone-r`（推送到 origin，同步至 2d4dc00）
- 工作区：干净（仅已跟踪文件）；未跟踪文件：`doc/vision-action-feedback.md`（未改动）

## 近期主要改动
- 重构 BACKLOG（2025-12-08）：分阶段（Phase1/2/3），新增“给新 Agent 的快速提示”。
- 新增愿景与行动文档：
  - `doc/VISION_BACKGROUND.md`：愿景/现状/规划概览
  - `doc/VISION_ACTIONS.md`：结合外部反馈的可落地行动分级
  - `doc/vision-feedback-claude.md`、`doc/vision-feedback-gpt.md`：外部反馈原文
- 回归：`scripts/verify-milestone-c.sh --full`（Jina 集合，默认 rerank 关）10/10 通过；新增 Tier3 影响面用例（阈值较低，仅存在性检查）

## 服务与集合
- Embedding：Jina v3 本地 7997（默认）；Nomic 集合存在但未复核。
- Rerank：MLX Jina v3 本地 7998 可用，默认关闭（需 `RERANK_ENABLED=1`）。
- Milvus：默认集合 `idea_symbols_spring_jina`（1024）；`idea_symbols_spring_nomic`/`idea_symbols` 3584 存在但质量未查。

## 待办（Phase1 P0 重点）
1) renderer v2 协议化（去噪/排序/限量，render_version/hash）
2) module 补全（class/method + callers/callees/moduleSummary）
3) 轻量 token boost（压同名/Getter/Setter 噪声，定义噪声率指标）
4) 1024 维 A/B + rerank：Jina v3 vs Jina-code-embeddings-1.5b@1024 vs Qwen3-Emb-4B@1024；rerank 试 Qwen3-Reranker-4B（TopK≈200，rerankK=80/100）
5) 影响面输出增强：callers/callees topN + module 分布 + source，预留 gaps；向下用例；模块补全后提高阈值

## 额外提醒
- 若要启动 Jina-code-embeddings-1.5b（2025-09-01），需调整 embedding 服务与 ingest/env，当前尚未切换；脚本仍默认 Jina v3。请在 A/B 试验前保持 schema=1024。
- 未跟踪文件 `doc/vision-action-feedback.md` 如需保留请后续纳入版本控制或忽略。

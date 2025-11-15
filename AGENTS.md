# Repository Guidelines

## Project Structure & Module Organization
The repo is split into three workspaces: `idea-bridge/` (Fastify bridge + Milvus ingestion scripts), `mcp-server/` (Model Context Protocol server that orchestrates staged search), and `idea-psi-exporter/` (IntelliJ plugin exporting PSI JSON). Shared design notes live under `doc/`. Run code inside each module’s directory; artifacts such as Gradle build output or `dist/` stay co-located.

## Build, Test, and Development Commands
- `npm run dev` (in `idea-bridge/`): rebuilds the TypeScript bridge with live-reload for `/api/psi/upload`. Use `npm run ingest:milvus` after PSI export to push into Milvus via the Python helper.
- `npm run dev` (in `mcp-server/`): starts the MCP server on stdio; pair with `npm run test` (Vitest) for unit coverage and `npm run typecheck` for stricter TS validation.
- `./gradlew build` (in `idea-psi-exporter/`): compiles the IntelliJ plugin; the action “Export PSI to Bridge” appears once the IDE loads the resulting sandbox build.

## Coding Style & Naming Conventions
TypeScript follows 2-space indentation, ES module syntax, and camelCase identifiers; prefer explicit return types for exported functions. Kotlin/Gradle code uses JetBrains defaults (4 spaces, PascalCase classes). Generated PSI payloads must match `idea-bridge/src/types.ts` and keep ASCII-only keys. Run `tsc --noEmit` or IntelliJ’s formatter before committing.

## Testing Guidelines
`mcp-server` tests run via Vitest; name specs `*.test.ts` and colocate next to the source. There are currently no automated tests in `idea-bridge` or the plugin, so functional verification happens through `npm run ingest:milvus` plus Fastify inject tests—add new suites when touching ingestion logic.

## Commit & Pull Request Guidelines
Existing history follows Conventional Commits (e.g., `feat: scaffold PSI exporter plugin`). Keep subject lines imperative under 72 chars, add context in the body, and reference issue IDs when available. Pull requests should describe the affected module, list validation steps (e.g., `./gradlew build`, `npm run test`), and include screenshots or logs for IDE-facing changes.

## Configuration Tips
Bridge uploads read `IDEA_BRIDGE_URL`; the MCP server expects `MILVUS_ADDRESS`, `MILVUS_COLLECTION`, and embedding host/model env vars. When testing locally, keep Milvus gRPC at `127.0.0.1:19530` and run Ollama on `11434`, or document any overrides in the PR description.

### MCP gRPC Troubleshooting
- Local shells often inherit HTTP/HTTPS/all-proxy env vars that break gRPC access to Dockerized Milvus. Before running MCP harnesses or `npm run tool:search`, clear those vars or follow the recipe in `doc/mcp-grpc-troubleshooting.md`.
- That doc also records the exact `source ../.venv/bin/activate && DISABLE_SCHEMA_CHECK=1 … npm run tool:search -- "<query>"` flow plus when to set `MAX_CONTEXT_TOKENS=4000` for Q5 stress tests. Always reference it when reproducing scenario queries.

## Codex Workflow Checklist
1. **At session start**: run `git status -sb`, peek at `git log --oneline -5`, and reread `AGENTS_CONTRIBUTING.md` plus `AI_CHANGELOG.md` to capture latest changes.
2. **File truth**: never trust chat memory—always open files from disk before editing; treat `doc/psi-integration-plan.md` as the canonical roadmap.
3. **Testing**: follow module-specific commands above; if a build can’t run in this environment (e.g., Gradle networking), note it explicitly.
4. **Documentation**: after meaningful work, append the results to `AI_CHANGELOG.md` (with date + pass name) and mention any limitations for the next agent.
5. **Coordination**: when uncertain or a refactor touches multiple modules, pause and ask the user before proceeding.
6. **Backlog loop**: for each BACKLOG.md item—implement & self-test, update schemas/tools/docs as needed, tick the relevant checkbox in BACKLOG.md, and log the pass in AI_CHANGELOG.md.
7. **Commit attribution**: 所有提交都必须在 message 尾部标明代理与回合，例如 `feat: update eval harness (by codex pass4)`，保持和 CLAUDE.md 的格式一致。

## 3. Feature 收尾与推送规则

### 3.1 当你宣称 “Milestone/Feature 完成” 或被要求推送时，必须执行

只要出现以下任一情况：

- 你在回复里写下 “Milestone X 完成了 / 这轮优化完成了 / 这个特性做完了” 等表述；
- 用户要求你 “先把这轮代码提交 / 推远端再继续开发”。

你必须在仓库根目录依次执行以下 **收尾仪式**，确保代码、文档与 CI 一致：

1. **本地构建校验**
   - 进入 `mcp-server/` 执行 `npm run build`。
   - 构建失败必须先修复；未通过前禁止继续 commit/push。

2. **一次性暂存本次特性相关文件**（至少包括下列路径，若有更多相关改动也需一并暂存）。
   - `mcp-server/src/**`
   - `mcp-server/scripts/**`
   - `.github/workflows/**`
   - `doc/SCENARIO_*.md`
   - `doc/README-eval.md`
   - `doc/mcp-grpc-troubleshooting.md`
   - `BACKLOG.md`
   - `AI_CHANGELOG.md`
   - 如果本轮修改了其他规则/设计文档（例如 `AGENTS.md`、`doc/embedding-layer.md`、`doc/idea-enhanced-context-design.md`），也必须一并暂存，禁止只推代码而不推文档。

3. **提交与推送**
   - 以单个语义化 commit 报告本次工作，并在 message 中注明代理身份，例如：`feat: finish Milestone B MCP search pipeline + eval harness (by codex pass5)`。
   - 使用 `git push --force-with-lease origin <当前分支>` 推送。

4. **收尾检查**
   - 在仓库根目录再次执行 `git status -sb`。
   - 期望只剩与本次特性无关的改动；若仍有相关文件未提交，回到步骤 2 继续处理。

### 3.2 文档与实现的一致性

以下文件被视为"权威规范/设计"，只要本轮修改了其中任意一个，就必须在同一次 feature commit 中提交：

- `AGENTS.md`：Agent 行为规范、协作流程；
- `CLAUDE.md`：Claude Code 专用指引（与 AGENTS.md 保持同步）；
- `doc/embedding-layer.md`：分段检索、上下文预算等核心设计；
- `doc/idea-enhanced-context-design.md`：系统架构设计；
- `doc/README-eval.md`：评测框架使用说明；
- 所有 `doc/SCENARIO_*.md` 评测/场景文档。

禁止出现 "代码行为已经变更，但对应规则/设计文档停留在旧描述" 的情况。

### 3.3 测试脚本与评测场景

当开发新功能或完成 Milestone 时，应同步更新：

- **功能测试**：`scripts/test-milestone-*.sh` - 验证核心能力是否正常工作
- **场景测试**：`mcp-server/scripts/run_eval.mjs` - 使用真实查询验证端到端行为
- **Fixture 数据**：`mcp-server/fixtures/petclinic-fixtures.json` - 更新 CI 基准数据

测试脚本必须包含：
1. 明确的验收标准（✅ / ❌ 输出）
2. 失败时的诊断信息
3. 在本地和 CI 环境都能运行的说明

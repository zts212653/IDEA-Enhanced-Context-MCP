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

## Codex Workflow Checklist
1. **At session start**: run `git status -sb`, peek at `git log --oneline -5`, and reread `AGENTS_CONTRIBUTING.md` plus `AI_CHANGELOG.md` to capture latest changes.
2. **File truth**: never trust chat memory—always open files from disk before editing; treat `doc/psi-integration-plan.md` as the canonical roadmap.
3. **Testing**: follow module-specific commands above; if a build can’t run in this environment (e.g., Gradle networking), note it explicitly.
4. **Documentation**: after meaningful work, append the results to `AI_CHANGELOG.md` (with date + pass name) and mention any limitations for the next agent.
5. **Coordination**: when uncertain or a refactor touches multiple modules, pause and ask the user before proceeding.
6. **Backlog loop**: for each BACKLOG.md item—implement & self-test, update schemas/tools/docs as needed, tick the relevant checkbox in BACKLOG.md, and log the pass in AI_CHANGELOG.md.

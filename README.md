# IDEA Enhanced Context MCP

Mono-repo for the staged search pipeline, bridge server, and IntelliJ PSI exporter used by the MCP server. The workspaces are:

- **idea-bridge/** – Fastify bridge + Python ingestor to Milvus. Handles PSI cache uploads and embedding/ingest.
- **mcp-server/** – MCP server that orchestrates staged search, profiles, context budgeting, and evaluation scripts.
- **idea-psi-exporter/** – IntelliJ plugin to export PSI JSON to the bridge.

## Quick Start (local, real data)

Prereqs: Node 20+, Python 3.10+, Milvus on `127.0.0.1:19530`, Ollama for embeddings.

```bash
# 1) Install deps per workspace
npm install && (cd idea-bridge && npm install) && (cd mcp-server && npm install)

# 2) Start bridge (reads PSI cache path and body limit envs)
cd idea-bridge
BRIDGE_BODY_LIMIT=$((50*1024*1024)) \  # adjust if 413
npm run dev  # or npm start

# 3) Export PSI in IntelliJ via the plugin (writes to BRIDGE_PSI_CACHE)
# 默认会按 projectName 写成 .idea-bridge/psi-cache-<project>.json；可用 BRIDGE_PSI_CACHE/BRIDGE_PSI_CACHE_DIR 覆盖

# 4) Ingest into Milvus (chunked, skips zero-norm vectors)
MILVUS_RESET=1 \
INGEST_CHUNK_SIZE=2000 \   # optional, default 2000
INGEST_LIMIT= \              # unset for full ingest; set small to smoke-test
NODE_OPTIONS="--max-old-space-size=8192" \  # avoid OOM on large projects
npm run ingest:milvus

# 5) Run a search
cd ../mcp-server
MAX_CONTEXT_TOKENS=9000 npm run tool:search -- "Which services depend on the discovery server?"
```

## Evaluation & Regression

- **Milestone B smoke tests**: `./scripts/run-milestone-b-with-env.sh` (writes logs to `tmp/milestone-b-tests/`; honors `BRIDGE_PSI_CACHE`).
- **Scenario regression**: see `doc/SCENARIO_REGRESSION.md` and templates in `doc/SCENARIO_TEMPLATES.md`.
- **Generator/Evaluator**: `mcp-server/scripts/generate_scenarios.mjs` and `run_eval.mjs` (with `--moduleFilter/--entityRegex/--typeFilter`).
- **Fixture mode (CI/offline)**: set `CI_FIXTURE=1` and run `node scripts/run_eval.mjs --fixtureOnly ...` to use `mcp-server/fixtures/petclinic-fixtures.json` instead of Milvus.

## Key Environment Variables

- **Bridge**: `BRIDGE_PSI_CACHE` (explicit file) or `BRIDGE_PSI_CACHE_DIR` (dir for per-project caches,默认将 projectName 写成 `psi-cache-<project>.json`); `BRIDGE_BODY_LIMIT` (default 50MB), `BRIDGE_PORT`, `BRIDGE_PROJECT_ROOT`.
- **Ingest**: `INGEST_LIMIT` (truncate symbols for smoke runs), `INGEST_CHUNK_SIZE` (default 2000 rows per chunk), `MILVUS_RESET=1` (recreate collection), `NODE_OPTIONS="--max-old-space-size=8192"` (large projects), `IEC_EMBED_MODEL` / `OLLAMA_HOST`.
- **MCP server**: `MILVUS_ADDRESS`, `PREFERRED_LEVELS`, `MAX_CONTEXT_TOKENS`, `MODULE_HINT`, `CI_FIXTURE` (fixture mode).

## Troubleshooting

- gRPC/proxy issues: `doc/mcp-grpc-troubleshooting.md`.
- Payload too large on PSI upload: raise `BRIDGE_BODY_LIMIT` or lower plugin batch size.
- Ingest OOM: use chunked ingest (`INGEST_CHUNK_SIZE`), raise Node heap, or limit symbols (`INGEST_LIMIT`).
- Zero vectors: ingest skips zero-norm embeddings; old rows can be deleted with the provided Python snippet (see chat notes or add to scripts if needed).

## Conventions & Collaboration

- Follow `AGENTS.md` for workflow/commit rules (attribution format `... (by codex passX)`), build-before-commit checklist, and authoritative docs list.
- Evaluate changes with the Milestone B scripts and `run_eval.mjs` when touching search pipeline, bridge ingest, or PSI/export behavior.
- Authoritative docs: `AGENTS.md`, `CLAUDE.md`, `doc/README-eval.md`, `doc/SCENARIO_*.md`, `doc/mcp-configuration-guide.md`, `doc/idea-enhanced-context-design.md`.

## Useful Scripts

- `idea-bridge`: `npm run dev`, `npm run ingest:milvus`, `npm run index:symbols`.
- `mcp-server`: `npm run dev`, `npm run tool:search -- "<query>"`, `node scripts/run_eval.mjs --scenarios=...`.
- Root: `./scripts/run-milestone-b-with-env.sh` (one-touch env + smoke tests).

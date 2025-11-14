# idea-enhanced-context MCP Server (prototype)

Minimal MCP server skeleton that exposes a `search_java_class` tool. The server now tries upstream providers in the following order:

1. IntelliJ IDEA Bridge HTTP API (if `IDEA_BRIDGE_BASE_URL` is configured)
2. Milvus vector search (if `MILVUS_*` + embedding env vars are configured)
3. Local mock data (fallback to keep the MCP tool responsive during development)

## Prerequisites

- Node.js ≥ 20 (repo dev box currently ships with v25.1.0)
- `npm` or `pnpm`/`yarn`

## Setup

```bash
cd mcp-server
npm install
```

## Development scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Runs the MCP server via `ts-node` for quick local iteration. |
| `npm run build` | Type-checks and emits JS into `dist/`. |
| `npm start` | Executes the compiled server (`dist/index.js`). |
| `npm run typecheck` | TypeScript type-only validation without emitting files. |
| `npm test` | Runs the Vitest suite that exercises the search pipeline fallbacks. |
| `npm run test:watch` | Watch mode for the same tests. |

## Tool semantics

- `search_java_class` — accepts `{ query: string, limit?: number, moduleFilter?: string }` and returns structured symbol hits. Each hit includes the FQN, kind, module, summary, heuristic score, and optional hints (references, staleness). The handler uses the search pipeline described above to pick the best available source.

Structured responses conform to the MCP `outputSchema`, and a human-readable JSON blob is also emitted as `text` content for convenience.

The current implementation uses the MCP “application/json” content type to stream structured payloads back to callers. Claude Code / Codex CLI can already parse this shape; once IDEA Bridge is online we only need to swap out `searchSymbols`.

## Configuration

### IDEA Bridge (optional)

Set one of the following to point at the IntelliJ plugin (or the mock bridge under `idea-bridge/`):

| Env var | Description |
|---------|-------------|
| `IDEA_BRIDGE_BASE_URL` (or `IDEA_BRIDGE_URL`) | Base URL for the Bridge (defaults to `http://127.0.0.1:63000`). |

When present, `search_java_class` will hit `GET /api/symbols/search` with `query`, `limit`, and `module` query params and rely on the plugin to return PSI-derived JSON.

### Milvus + Embedding (optional, but now wired)

| Env var | Default | Purpose |
|---------|---------|---------|
| `MILVUS_HTTP_ENDPOINT` | `http://127.0.0.1:9091` | Milvus HTTP API base. |
| `MILVUS_COLLECTION` | `idea_symbols` | Collection to search. |
| `MILVUS_VECTOR_FIELD` | `embedding` | Vector field (anns_field). |
| `MILVUS_OUTPUT_FIELDS` | `fqn,summary,module,kind,references,last_modified_days` | Fields to return. |
| `MILVUS_METRIC` | `IP` | Metric type. |
| `MILVUS_PARAM_EF` / `MILVUS_PARAM_NPROBE` | `200` / `16` | Search params forwarded to Milvus. |
| `IEC_EMBED_MODEL` / `EMBED_MODEL` | `manutic/nomic-embed-code` | Embedding model name (used for query embeddings through Ollama or another compatible endpoint). |
| `OLLAMA_HOST` / `EMBEDDING_HOST` | `http://127.0.0.1:11434` | Base URL for the embedding service. |

If the env vars are missing or Milvus/embedding calls fail, the pipeline logs a warning and drops to the mock dataset automatically.

> ⚠️ 由于 Node gRPC 在当前沙箱下无法直接连到 Milvus，`milvusClient` 会把查询写入一个临时 JSON，再调用 `idea-bridge/scripts/milvus_query.py`（基于 `pymilvus`）执行真正的向量检索。因此需要确保本机 Python 可执行 `pymilvus`，并允许 CLI 命令在需要时运行 Python 子进程。

### Mock data

The fallback dataset lives inside `src/index.ts` to guarantee the MCP tool never fails outright during development. Update this list to simulate specific projects/modules when testing new prompt strategies.

## Testing

`npm test` runs `src/searchPipeline.test.ts`, which verifies:

1. Bridge results short-circuit the pipeline.  
2. Milvus results are used when the bridge is absent.  
3. The mock dataset is returned when both upstreams fail.

Feel free to expand these tests as the Bridge & Milvus contracts evolve (e.g., add regression tests around new metadata fields or ranking rules).

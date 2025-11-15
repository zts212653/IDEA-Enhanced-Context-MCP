# IDEA Bridge prototype

This package scans a local IntelliJ project (default: `~/projects/spring-petclinic-microservices`) and exposes a lightweight HTTP API that mimics the future IDEA Index Bridge while we develop the actual IntelliJ plugin.

## Commands

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run dev` | Start the Fastify server directly from TypeScript (watches not included). |
| `npm start` | Run the compiled server from `dist/server.js`. |
| `npm run ingest:milvus` | Build symbol records, generate embeddings, and call the Python ingestor to recreate+populate the Milvus collection. |
| `npm run index:symbols` | Emit the raw symbol list as JSON (mainly for debugging). |
| `POST /api/psi/upload` | Replace the in-memory symbol index with a PSI-export payload (see PSI plan). |

## HTTP API

After running `npm run dev` (or `npm start`), the server listens on `BRIDGE_PORT` (default `63000`):

- `GET /healthz` – readiness probe.
- `GET /api/info` – project root + symbol count.
- `GET /api/symbols/search?query=foo&limit=10&module=auth-service` – fuzzy search backed by a MiniSearch index over class/interface metadata.
- `GET /api/symbols/:fqn` – fetch a single symbol record.

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PROJECT_ROOT` | `~/projects/spring-petclinic-microservices` | Project to scan for `.java` sources. |
| `BRIDGE_PORT` | `63000` | HTTP port for the bridge server. |
| `IEC_EMBED_MODEL` | `manutic/nomic-embed-code` | Embedding model name passed to Ollama (also used by `mcp-server`). |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Embedding service base URL. |

## Milvus ingestion

`npm run ingest:milvus` performs the following:

1. Builds the symbol index (same logic used by the HTTP server).
2. Generates embeddings via Ollama; if the local model emits invalid values, the script falls back to a deterministic hashing vector so the pipeline keeps working.
3. Writes the enriched rows to a temp JSON file.
4. Invokes `scripts/milvus_ingest.py`, which uses `pymilvus` to drop/recreate the `idea_symbols` collection, build the IVF index, insert all rows, and load the collection.

Prerequisites:

- Milvus running locally (the repo’s `.idea-enhanced-context` compose stack, ports 19530/9091).
- `pymilvus` installed (`pip install --user pymilvus` as done in `doc/quick_start.sh`).
- Local Ollama server with the configured embedding model.

You can set `MILVUS_RESET=1` (default when the script is invoked) to force a clean collection each ingest run.

## Pending work

- Replace the regex-based parser with a real IntelliJ PSI exporter once the IDEA plugin is available.
- Extend the HTTP API to stream reference graphs, inheritance, and incremental change events.
- Add structured tests for the indexer once we stabilise the parsing strategy.

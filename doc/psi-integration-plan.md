# PSI Bridge Integration Plan (Single Source of Truth)

## 1. Current State Snapshot (2025-11)
- **IntelliJ plugin (`idea-psi-exporter/`)**: exports Java PSI for classes with methods/fields/annotations plus preliminary hierarchy & Spring hints, wraps all symbols in a schema-versioned payload, and posts to `/api/psi/upload`. Still missing reference graphs, settings UI, and incremental triggers.
- **Bridge (`idea-bridge/`)**: loads PSI cache on boot (`.idea-bridge/psi-cache.json`), treats uploads as authoritative, and exposes enriched `SymbolRecord` fields (hierarchy/relations). Regex indexer remains only as fallback; ingestion still needs to consume the new metadata.
- **MCP server (`mcp-server/`)**: staged search + context budgeting wired up, but still consumes legacy ingestion output (mock or regex data) until Milvus pipeline uses PSI-rich records.

## 2. Gaps vs Desired Experience
1. **Semantic fidelity**: need callers/callees, inheritance, Spring wiring, and module dependency rolls-ups per class/method (see `doc/idea-bridge-vs-not.md`).
2. **Data freshness**: exporter should re-run on file/module changes and persist schema version so bridge can cache PSI artifacts across restarts.
3. **Embedding quality**: ingestion must consume PSI-rich metadata and produce differentiated repository/module/class/method vectors following `doc/embedding-layer.md`.
4. **Operational flow**: single command (or IDE action) should run exporter → upload → ingest → verify search against a reference repo (e.g., `~/projects/spring-petclinic-microservices`).

## 3. Work Plan
### A. PSI Exporter Enhancements
1. Add collectors for:
   - Reference graphs (`FindUsagesHandler`, `CallHierarchyNodeDescriptor`) to populate `references`, `calledBy`, `calls`.
   - Inheritance & overrides (`SuperMethodsSearch`, `DirectClassInheritorsSearch`).
   - Spring wiring heuristics (annotation whitelist, bean names, injected field wiring).
2. Provide settings panel + action dialog:
   - Bridge URL, batch size, include/exclude modules, schema version.
   - Progress indicator with per-batch status + error log.
3. Optional Phase: incremental export through `PsiTreeChangeListener` & `VirtualFileListener`, writing changed symbols to a retry queue.

### B. Bridge & Schema Updates
1. ✅ Extend `SymbolRecord` (`idea-bridge/src/types.ts`) to store references, inheritance, spring info (done; relations placeholders still need real data).
2. ✅ Persist latest PSI payload under `.idea-bridge/psi-cache.json` so server warm-starts from PSI instead of regex.
3. Update `/api/psi/upload` to stream-ingest batches (backpressure, gzip) and emit audit logs. *(remaining)*

### C. Embedding & Search Pipeline
1. Refresh `symbolToEmbeddingText` and `ingest:milvus` to include new metadata, maintain repo/module/class/method levels, and calculate smarter summaries (method roles, dependency counts).
2. Until Node gRPC constraints lift, harden Python Milvus helper with health checks + exponential backoff; afterwards, switch to native SDK path noted in `doc/milvus-node-connectivity.md`.
3. Update MCP tool output to expose module hits, index levels, and context-budget diagnostics so downstream agents can stage queries (`doc/embedding-layer.md` guidance).

### D. Validation Loop
1. Reference repo: `~/projects/spring-petclinic-microservices`.
2. Script (`scripts/e2e-psi.sh`):
   - Launch Milvus + Ollama.
   - Run IntelliJ exporter headlessly (or via CLI action).
   - Upload to bridge, trigger `npm run ingest:milvus`.
   - Call MCP search tool with canned queries (Spring beans, repository usages) and assert expected hits.
3. Document reproducible steps in `doc/psi-integration-status.md`, updating as we hit milestones.

## 4. Ownership & Timeline
| Track | Owner | ETA |
| --- | --- | --- |
| PSI exporter enrichments + settings | IDE plugin team | Week 1-2 |
| Bridge schema/storage + PSI-first boot | Bridge maintainer | Week 2 |
| Embedding/search hardening | MCP team | Week 3 |
| End-to-end validation + docs | Shared | Week 4 |

This document supersedes previous plugin-specific plans; keep it updated as the canonical spec for PSI integration work.

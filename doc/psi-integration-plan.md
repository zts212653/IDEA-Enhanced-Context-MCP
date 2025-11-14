# PSI Integration Plan

## Why we need PSI data
- Regex-based indexer misses relationship metadata (call graphs, Spring wiring, module dependencies). Docs (`doc/idea-enhanced-context-design.md`, §3) call for PSI-derived hierarchy, references, annotations, etc.
- JetBrains MCP tools only provide single-file operations (`doc/jetbrains-mcp-research.md`), so we must ship our own bridge plugin.

## Target deliverables
1. **PSI exporter** (IntelliJ plugin or standalone bridge)
   - Enumerate classes/methods/fields with fully-resolved types.
   - Capture relationships: extends/implements, references, Spring annotations, callers.
   - Deliver events for incremental changes (optional later).
2. **Bridge ingestion endpoint**
   - Current Node bridge should accept pre-serialized PSI JSON and reuse embedding/index pipeline.
   - Endpoint shape proposal:
     ```json
     POST /api/psi/upload
     {
       "repo": "spring-petclinic-microservices",
       "modules": [...],
       "symbols": [ { ... enriched metadata ... } ]
     }
     ```
3. **Backpressure & batching**
   - Large repos require chunked uploads (e.g., 500 symbols per batch) with idempotency tokens.

## Data schema (draft)
- Base `SymbolRecord` fields already exist in `idea-bridge/src/types.ts`. PSI exporter should produce the same shape:
  - `repoName`, `module`, `modulePath`, `packageName`, `fqn`, `kind` (CLASS/INTERFACE/METHOD).
  - `annotations`, `fields`, `methods` (with param/return FQNs), `springInfo`, `dependencies`.
  - `metadata` extras (e.g., `callers`, `owners`, `gitInfo`).
- For method-level records, supply `overrides`, `calledMethods`, `isBlocking`, etc. (PSI has this via `CallHierarchyNodeDescriptor`).

## Integration workflow
1. IntelliJ plugin traverses PSI (using `JavaRecursiveElementVisitor` or `FilenameIndex` + `PsiShortNamesCache`).
2. Serialize into the above schema, chunked per module.
3. POST to bridge’s `/api/psi/upload`.
4. Bridge writes to disk or queue, triggers existing embedding pipeline (`symbolToEmbeddingText` already expects these fields).
5. Milvus ingestion stays unchanged (already multi-level).

## Open questions / next steps
- Authentication between IDE and bridge API? (Local only vs remote CI jobs.)
- Incremental updates: watch for file edits and only resend affected symbols.
- Versioning: include `ideaVersion`, `pluginVersion`, `schemaVersion` to avoid drift.
- Testing: create sample PSI export JSON under `tests/fixtures` to validate ingestion without IDE.

## Action items
1. Spec IntelliJ plugin tasks (PSI traversal + HTTP push).
2. Implement `/api/psi/upload` in Node bridge + storage queue.
3. Build integration test using fixture data to ensure embeddings/index update correctly once PSI feed arrives.

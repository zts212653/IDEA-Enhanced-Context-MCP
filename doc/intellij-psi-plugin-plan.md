# IntelliJ PSI Export Plugin Plan

## Goals
- Export complete PSI metadata (classes, methods, fields, annotations, Spring wiring, references) for large projects.
- Stream data to `idea-bridge` via `/api/psi/upload`, reusing existing embedding/index pipeline.
- Support full refresh first, incremental updates later.

## Architecture
1. **Plugin Module (`idea-psi-exporter`)**
   - Kotlin/Java plugin using IntelliJ Platform SDK (2025.x).
   - Provides actions + background tasks to traverse PSI.
2. **Export Pipeline**
   - Traverse modules via `ModuleManager`, `JavaPsiFacade`.
   - For each `PsiClass`, collect:
     - fully qualified name, package, modifiers, Javadoc, annotations
     - methods (signature, params/return FQNs, overrides)
     - fields (types, annotations, injection hints)
     - dependencies (extends/implements, references)
     - Spring-specific metadata (via `PsiAnnotation`
3. **Serialization**
   - Map PSI fields to existing `SymbolRecord` schema in `idea-bridge/src/types.ts`.
   - Chunk output per module (e.g., 500 symbols per batch) to limit payload size.
4. **Transport**
   - HTTP client inside plugin posts JSON to bridge `/api/psi/upload`.
   - Configurable bridge URL (default `http://127.0.0.1:63000`).
5. **Incremental Updates (Phase 2)**
   - Listen to `PsiTreeChangeListener` / `VirtualFileManager` to re-export changed classes.

## Development Milestones
1. **Week 1 – Skeleton & Full Export Prototype**
   - Setup Gradle IntelliJ plugin project.
   - Implement action “Export PSI” that traverses all modules and writes JSON to disk.
   - Validate output against `SymbolRecord` schema.
2. **Week 2 – Bridge Integration**
   - Add HTTP uploader to POST batches to `/api/psi/upload`.
   - Run against `spring-petclinic-microservices` to refresh bridge & Milvus.
3. **Week 3 – Incremental & UX**
   - Hook change listeners, add progress UI, error reporting.
   - Optional: schedule periodic exports or integrate with JetBrains MCP commands.
4. **Week 4+ – Hardening**
   - Authentication, retries, batching controls, gzip payloads.
   - Integration tests using fixture projects.

## Dependencies
- IntelliJ Platform SDK 2025.x
- Kotlin (preferred) or Java for plugin code
- HTTP client (`java.net.http` or OkHttp)

## Next Action Items
1. Scaffold plugin module in repo (`idea-psi-exporter/`).
2. Implement PSI traversal + JSON serializer.
3. Wire HTTP uploader to existing bridge endpoint.

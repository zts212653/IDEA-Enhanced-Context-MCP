# Milestone C Status Report

**Date**: 2025-11-25  
**Agent**: Codex (this pass)  
**Scope**: C.1 method-level index sanity check + callers tool verification

---

## 1. Environment Snapshot (This Pass)

- Python venv: `.venv` exists and contains `pymilvus`, but Milvus itself is **not reachable** at `127.0.0.1:19530` in this harness:
  - `MILVUS_CHECK_ERROR MilvusException: Fail connecting to server on 127.0.0.1:19530`.
- Embedding host: calls to `http://127.0.0.1:11434/api/embeddings` fail with `connect EPERM` under this sandbox:
  - `generateEmbedding()` falls back to deterministic hash embeddings.
- Despite these limitations, the MCP server and PSI cache are usable:
  - `npm run tool:search` runs but falls back (no Milvus hits) and returns `fallbackUsed: true` for AOP-style queries in this environment.
  - `analyze_callers_of_method` works end-to-end against the PSI cache and returns meaningful callers for Spring Framework methods.

> Implication: This pass can confirm the **static wiring** of method-level indexing and the callers tool, but cannot re-run full Milvus-backed semantic search in this sandbox. All dynamic observations below are based on existing JSON fixtures under `tmp/` plus tool calls that do not depend on Milvus.

---

## 2. C.1 · Method-Level Index (indexLevel = "method")

### 2.1 Implementation Status (Static Wiring)

**PSI Exporter (`idea-psi-exporter/`)**
- `PsiCollectors.kt:136` (`methodInfo`):
  - Exports per-method structure: `name`, `parameters (type/typeFqn + name)`, `returnType/returnTypeFqn`, `visibility`, `annotations`, and `javadoc`.
  - All of these are bundled into `MethodInfo` and included in each class-level `SymbolRecord.methods`.
- `RelationInfo` is currently **class-level**:
  - `relations.calls`: set of `SomeClass#someMethod` strings aggregated per class.
  - `relations.references`: class-level referenced types.
  - Per-method call graphs remain a potential future enhancement (C.2/C.4), not a blocker for C.1.

**Bridge Ingestion (`idea-bridge/src/scripts/ingestMilvus.ts`)**
- `buildIndexEntries()`:
  - Generates repository, module, class, and **method** entries from PSI `SymbolRecord`s.
  - Respects `INGEST_MODULE_FILTER` and `INGEST_LIMIT` to trim records before entry generation.
- `buildMethodEntry()`:
  - Creates one `IndexEntry` per method with:
    - `level: "method"` → maps to `index_level = "method"` in Milvus payload.
    - `repoName`, `moduleName/modulePath`, `packageName`, and `symbolName/fqn` set to `ClassFqn#methodName`.
    - `summary`: the method signature.
    - `metadata`: includes owning class FQN, module, parameters, return type, annotations, and visibility.
  - `embeddingText` includes:
    - Class FQN + method name, signature, return type, parameter types, module, and package.
    - This is already sufficient for basic method-level retrieval; javadoc + call summary can be layered in later as we refine embeddings.
- `prepareRow()`:
  - Writes `index_level`, `repo_name`, `module_name`, `module_path`, `package_name`, `symbol_name`, `fqn`, `summary`, and JSON-encoded `metadata` into the Milvus rows.

**Milvus Query Path**
- Python helper (`idea-bridge/scripts/milvus_query.py`):
  - Accepts a `levels` array and translates it to an expression `index_level == "method"` (or combined) for Milvus queries.
  - Returns `index_level`, `repo_name`, `module_name`, `package_name`, `symbol_name`, `summary`, `metadata`, `fqn`, `score`, plus any configured `outputFields`.
- Node client (`mcp-server/src/milvusClient.ts`):
  - `formatRecords()`:
    - Interprets `row.index_level`:
      - `"method"` → `kind: "METHOD"`, `indexLevel: "method"`.
      - Normalizes `repoName/modulePath/packageName` from row and `metadata`.
    - Parses `metadata` back into a `SymbolRecord` with `relations`, `hierarchy`, `springInfo`, and `uploadInfo`.
  - `createMilvusSearchClient().search()`:
    - Calls `runPythonSearch()` with `levels: args.preferredLevels ?? ["class", "method"]`.
    - For method-focused stages, `searchPipeline` passes `preferredLevels: ["method"]`, so Milvus only returns `index_level = "method"` rows.
- Search pipeline (`mcp-server/src/searchPipeline.ts`):
  - Declares a `milvus-method` stage alongside `milvus-module` and `milvus-class`.
  - When `strategy.preferredLevels.includes("method")` and `methodLimit > 0`, it:
    - Issues a Milvus query with `preferredLevels: ["method"]` and a method-tailored query string.
    - Registers results under `stageHits["milvus-method"]`.
  - Final `SearchOutcome` exposes:
    - `methodResults: filteredStageHits["milvus-method"]`.
    - `stages[]` containing an entry with `name: "milvus-method"` when method hits are available.

**Conclusion**: The **end-to-end method-level index wiring (PSI → bridge ingest → Milvus schema → MCP search pipeline)** is in place and consistent with the design in `doc/embedding-layer.md`. What remains for C.1 is primarily **quality validation and documentation**, not core plumbing.

### 2.2 Evidence from Existing Fixtures (`tmp/`)

Because Milvus and the embedding host cannot be reached in this sandbox, dynamic validation relies on previously captured JSON outputs under `tmp/`:

- `tmp/c1-method-jdbc.json`:
  - Query: `"ConstructorPersonWithSetters"` with `preferredLevels: ["method"]`, `moduleHint: "spring-jdbc"`.
  - Result:
    - `fallbackUsed: false`, `deliveredResults[0].fqn = "org.springframework.jdbc.core.test.ConstructorPersonWithSetters"`.
    - `stages[0].name = "bridge"` with `kinds: ["CLASS"]`.
  - Interpretation:
    - Confirms that **bridge-backed PSI search** can serve method-oriented queries even when method-level Milvus is not used.
    - Does not yet demonstrate `milvus-method` stage hits, but shows that method-level query routing and PSI metadata are usable.

- `tmp/search-beanpp.json`:
  - BeanPostProcessor scenario with broader `preferredLevels`:
    - Contains `deliveredResults` items where:
      - `kind: "METHOD"`, `indexLevel: "method"`, and method-level metadata fields (class FQN, parameters, return type, visibility) are populated.
    - Demonstrates that method-level rows (`index_level = "method"`) have been ingested and can be surfaced by the MCP server.

- `tmp/search-aop-proxies.json`, `tmp/search-bean-scanning.json`, `tmp/search-events.json`:
  - Focused on class-level AOP / bean scanning / events queries.
  - Show `stages[0].name = "milvus-class"` with `indexLevel: "class"` hits, while method-level results are mostly secondary.
  - These fixtures are more relevant to C.3 ranking but confirm that staged search is exercising the Milvus class-level layers correctly.

### 2.3 Validation Gaps in the Initial Sandbox Pass

In the earlier sandboxed run (before Milvus/network access was enabled for this agent), it was **not possible** to:

- Connect to the live Milvus instance at `127.0.0.1:19530`.
- Reach the embedding host (`127.0.0.1:11434`) except via the internal hash-based fallback.
- Re-run `npm run ingest:milvus` end-to-end or observe fresh `milvus-method` hits in the logs.

At that time we could only confirm that all **code paths** needed for method-level indexing existed (via fixtures), but we did not yet have a full-environment view of:

- How often `milvus-method` contributes to the final ranking on complex queries.
- How method-level hits interact with Ranking B.1 boosts/penalties in real Milvus searches.

### 2.4 Recommended C.1 Verification Loop (for a Full Environment)

When Milvus and the embedding host are available, a human or future agent should:

1. **Prepare Environment**
   - Ensure Python venv is active and has `pymilvus`:
     - `source .venv/bin/activate`
   - Start Milvus and the embedding provider (e.g. Ollama) as documented in `doc/mcp-configuration-guide.md`.
   - Export fresh PSI from Spring Framework via the IntelliJ plugin and upload to the bridge.
   - Run `npm run ingest:milvus` in `idea-bridge/` to regenerate vectors (including `indexLevel = "method"` rows).

2. **Run Method-Focused Queries**
   - Use `PREFERRED_LEVELS=method` and targeted queries, for example:
     - `"ConstructorPersonWithSetters"` with `MODULE_HINT=spring-jdbc`.
     - `"How does JdbcTemplate.query delegate to NamedParameterJdbcTemplate and SimpleJdbcCall?"` with `MODULE_HINT=spring-jdbc`.
     - `"Where is AbstractTransactionStatus.setRollbackOnly used?"` as a more impact-style method query.
   - Capture outputs into `tmp/c1-method-*.json` via:
     - `PREFERRED_LEVELS=method MODULE_HINT=... npm run tool:search -- "<query>" > ../tmp/c1-method-<slug>.json`.

3. **Evaluate**
   - Confirm that:
     - `stages` includes `"milvus-method"` with non-zero `hitCount`.
     - Top `deliveredResults` entries for method-oriented queries have `indexLevel = "method"` and meaningful summaries.
     - For hybrid queries (class + method), method-level hits contribute in a sensible way without drowning out key classes.
   - Record findings and edge cases in this file under a new dated section (e.g. “2025-12-XX – Full Milvus Env Verification”).

4. **Decide on C.1 Status**
   - If method-level hits are consistently useful and not noisy, Milestone C.1 can be marked as fully ✅ in `BACKLOG.md`.
   - If results are technically correct but semantically weak (e.g. too many trivial getters/setters), update C.1/C.3 plans to include embedding-text refinements or additional ranking signals.

### 2.5 Full-Environment Check (2025-11-25, Milvus + Embedding Enabled)

With Docker/Milvus and the embedding endpoint now reachable from this agent, we re-ran a subset of the above verification loop using the existing Spring Framework PSI cache and Milvus collection (`idea_symbols`, row_count ≈ 76,969).

**Environment Notes**
- Python venv: `.venv` activated before running MCP searches so that `python3` inside `milvus_query.py` can import `pymilvus`.
- Milvus: `connections.connect(alias="default", address="127.0.0.1:19530"); Collection("idea_symbols").num_entities == 76969`.
- Embedding: MCP searches no longer fail with `EPERM` or connection errors; `milvusClient` is able to embed and query via `milvus_query.py`.

**Query A – AOP Dynamic Proxies (Class + Method Levels)**
- Command:
  - `PREFERRED_LEVELS=class,method MODULE_HINT=spring-aop DISABLE_SCHEMA_CHECK=1 npm run tool:search -- "How does Spring AOP create dynamic proxies and apply advice?"`
  - Output saved to `tmp/search-aop-full.json`.
- Observations:
  - `fallbackUsed: false`.
  - `stages` contains:
    - `"milvus-class"` with `hitCount: 6`.
    - `"milvus-method"` with `hitCount: 4`.
  - `deliveredResults` mixes class-level and method-level hits; the top method-level result is:
    - `org.springframework.aop.aspectj.AspectJAroundAdvice#lazyGetProceedingJoinPoint` (module `spring-aop`), whose Javadoc explicitly explains how to obtain a `ProceedingJoinPoint` for advice — very aligned with the query.
  - The remaining method hits (JCA/JMS/JMX helper methods) are moderately relevant but clearly tied to proxy/descriptor creation patterns, not random noise.

**Query B – AOP Dynamic Proxies (Method Only)**
- Command:
  - `PREFERRED_LEVELS=method MODULE_HINT=spring-aop DISABLE_SCHEMA_CHECK=1 npm run tool:search -- "How does Spring AOP create dynamic proxies and apply advice?"`
  - Output saved to `tmp/c1-method-aop-full.json`.
- Observations:
  - `fallbackUsed: false`, `totalCandidates: 4`, `deliveredCount: 4`.
  - `stages` contains a single entry:
    - `"milvus-method"` with `hitCount: 4` and `levels: ["method"]`.
  - All delivered results have `indexLevel: "method"` and reasonable summaries; the top hit is again `AspectJAroundAdvice#lazyGetProceedingJoinPoint`, confirming that:
    - The `milvus-method` stage is active and able to surface genuinely useful AOP entrypoints for method-oriented questions.

**Query C – ConstructorPersonWithSetters (Bridge-Only, Targeted)**
- Command:
  - `PREFERRED_LEVELS=method MODULE_HINT=spring-jdbc DISABLE_SCHEMA_CHECK=1 npm run tool:search -- "ConstructorPersonWithSetters"`
  - Output saved to `tmp/c1-method-jdbc-full.json`.
- Observations:
  - Strategy profile: `"targeted"`; `allowBridgeStage === true` in the search pipeline.
  - `stages` contains only:
    - `"bridge"` with `hitCount: 1`, returning the class `org.springframework.jdbc.core.test.ConstructorPersonWithSetters`.
  - This validates the bridge-first path for very short, name-like queries; method-level Milvus is intentionally bypassed once a high-confidence PSI match is found.

**C.1 Experience Summary**
- For AOP-style, explanation-heavy queries with `PREFERRED_LEVELS` including `"method"`, the `milvus-method` stage:
  - Is invoked and returns non-empty hits.
  - Surfaces method-level entries whose summaries and owning classes match the semantic intent of the question (especially `lazyGetProceedingJoinPoint`).
- For very short “name” queries (like `ConstructorPersonWithSetters`), the targeted profile prefers the PSI bridge and returns the right class quickly without needing method-level Milvus.
- Overall, the method-level index behaves as designed:
  - Architecture-wise it is fully wired.
  - Experience-wise it is already helpful on AOP-style queries, with room to refine method ranking in future C.3 work.

→ Based on this full-environment check, Milestone C.1 can be treated as **plumbing-complete and experience-acceptable for AOP scenarios**, with further method-level ranking tweaks deferred to C.3.

### 2.6 Jina vs Nomic A/B (2025-12-02)

**Setup**
- Jina collection: `idea_symbols_spring_jina` (dim=1024), provider=jina, host `http://127.0.0.1:7997`.
- Nomic collection: `idea_symbols`/`idea_symbols_spring_nomic` (dim=3584), provider=ollama, model `manutic/nomic-embed-code`.
- Queries (all with `preferredLevels=class,method` unless noted): AOP proxies, Tx rollback, Event multicast, WebFlux ServerResponse (method-only), JdbcTemplate→RowMapper.

**Findings**
- Jina: All five queries return on-topic method/class hits (AOP proxy constructors/auto-proxy creators; TX rollback/setRollbackOnly APIs; ApplicationEventMulticaster#multicastEvent; ServerResponse#created; JdbcTemplate/MappingSqlQuery RowMapper paths). No fallback.
- Nomic: Frequently drifts to generic Spring Beans configuration classes (PropertyAccessor, YAML factories, PointcutComponentDefinition); WebFlux query fell back entirely; AOP/JDBC hits include some relevant items but mixed with off-topic infrastructure.

**Conclusion**
- For Spring Framework, Jina embeddings are clearly superior and should be the default collection for Milestone C validation and demos. Nomic can remain as a comparison baseline but is not recommended for primary use.

---

## 3. C.4 · `analyze_callers_of_method` Sanity Check

Although C.4 is already marked as implemented in `BACKLOG.md`, this pass re-validated its behavior in the current environment.

### 3.1 Tool Behavior (Current)

- Invoking the MCP tool:
  - Tool: `analyze_callers_of_method`
  - Arguments:
    - `methodFqn: "org.springframework.jdbc.core.JdbcTemplate#query"`
    - `excludeTest: true`
    - `maxResults: 50`
- Observed output (via a one-off MCP client script):
  - `targetMethod: "org.springframework.jdbc.core.JdbcTemplate#query"`
  - `targetClass: "org.springframework.jdbc.core.JdbcTemplate"`
  - `callers[]` includes production callers such as:
    - `org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate`
    - `org.springframework.jdbc.core.simple.SimpleJdbcCall`
    - `org.springframework.jdbc.core.simple.SimpleJdbcInsert`
    - `org.springframework.jdbc.core.simple.DefaultJdbcClient`
    - `org.springframework.jdbc.object.StoredProcedure`, etc.
  - All returned entries have `module: "spring-framework"` and `isTest: false`, confirming that:
    - The `excludeTest` filter works.
    - PSI cache `relations.calls` and `relations.references` are wired correctly for this case.

### 3.2 Relationship to C.1/C.2

- This tool currently operates **purely on the PSI cache**, without Milvus:
  - It is not blocked by the missing Milvus/embedding host.
  - It already provides the “where is this method used in production code?” primitive that C.2/C.4 depend on.
- Once `callersCount/calleesCount` are pushed into Milvus metadata (C.2), we can:
  - Use the same relations to:
    - Power impact/migration ranking profiles.
    - Distinguish high-impact methods (many production callers) from low-impact ones.

---

## 4. Handoff Notes for Next Agents

- **C.1 (Method-Level Index)**:
  - Plumbing is in place end-to-end; this pass focused on documenting the current state and outlining a concrete verification loop.
  - Next steps:
    - Run the verification loop described in §2.4 in a full environment.
    - Decide whether method-level embedding text needs to incorporate per-method call summaries or javadoc more heavily.
    - Update `BACKLOG.md` to mark C.1 as fully complete once semantic quality is acceptable.

- **C.2 (Callers/References in Milvus Metadata)**:
  - PSI-side `relations.calls`/`relations.references` are present; module-level `relationSummary` is already computed during ingest.
  - Next concrete implementation step:
    - Aggregate `callersCount`/`calleesCount` during ingestion and store them in method/class metadata for use by ranking.

- **C.4 (Callers Tool Enhancements)**:
  - Current implementation provides a flat `callers[]` list.
  - Future refinement (as already noted in `BACKLOG.md`):
    - Split output into `directCallers[]` vs `referrers[]`.
    - Optionally aggregate by module and sort by frequency for impact/migration scenarios.

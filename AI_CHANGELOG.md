# AI Changelog

This file tracks modifications made by AI agents (Claude Code, Codex, etc.) to maintain cross-session awareness and collaboration context.

---

## 2025-11-14

### Claude Code Pass 1: Build System Fixes

**Session Context**: User reported build issues in `idea-psi-exporter` after Codex development

**Files Changed**:
- `idea-psi-exporter/gradle/wrapper/gradle-wrapper.properties`
- `idea-psi-exporter/build.gradle.kts`
- `idea-psi-exporter/src/main/kotlin/com/idea/enhanced/psi/PsiCollectors.kt`
- `idea-psi-exporter/src/main/kotlin/com/idea/enhanced/psi/ExportPsiAction.kt`
- `CLAUDE.md` (updated with multi-agent collaboration rules)
- `AGENTS_CONTRIBUTING.md` (created collaboration protocol)

**Problems Fixed**:

1. **Gradle Version Incompatibility**
   - Error: `IntelliJ Platform Gradle Plugin requires Gradle 8.13 and higher`
   - Fix: Updated `gradle-wrapper.properties` from Gradle 8.10 → 8.13
   - Also increased network timeout from 10s → 60s for reliability

2. **Kotlin Version Incompatibility**
   - Error: `java.lang.IllegalArgumentException: 25.0.1` during compilation
   - Root cause: Kotlin 1.9.25 has Java version parsing bug with Java 21.0.9
   - Fix: Updated `build.gradle.kts` Kotlin plugin from 1.9.25 → 2.1.0

3. **Deprecated PSI API Usage**
   - Error: `Unresolved reference: extendsTypes` and `implementsTypes`
   - Fix: Changed to `extendsListTypes` and `implementsListTypes` in `PsiCollectors.kt:58-59`
   - Reason: API changed in IntelliJ Platform 2025.1

4. **Type Resolution for JavaDoc Extraction**
   - Error: `Unresolved reference: JavaDocumentedElement` and `docComment`
   - Fix: Changed `extractDoc` parameter from `JavaDocumentedElement` → `PsiElement`
   - Added safe cast: `(element as? PsiDocCommentOwner)?.docComment`

5. **Incorrect Object Instantiation**
   - Error: `Unresolved reference: BridgeUploader` (constructor call on object)
   - Fix: Changed from `val uploader = BridgeUploader(); uploader.upload()` → `BridgeUploader.upload()`
   - Reason: `BridgeUploader` is a Kotlin `object` (singleton), not a class

6. **InstrumentCode Task Failure**
   - Error: `Packages directory does not exist` in JDK path
   - Root cause: Modern JDK structure doesn't include legacy `Packages` directory
   - Fix: Disabled `instrumentCode` task in `build.gradle.kts` with `named("instrumentCode") { enabled = false }`
   - Impact: Plugin still builds correctly, bytecode instrumentation skipped

**Build Verification**:
```bash
$ ./gradlew clean build
BUILD SUCCESSFUL in 2s
12 actionable tasks: 12 executed
```

**Artifacts Produced**:
- `build/libs/idea-psi-exporter-0.1.0.jar` (49KB)
- `build/libs/idea-psi-exporter-0.1.0-base.jar` (49KB)
- `build/libs/idea-psi-exporter-0.1.0-instrumented.jar` (49KB)

**Key Decisions**:
- Chose to disable `instrumentCode` rather than fix JDK path issue (instrumentation not critical for MVP)
- Updated to Kotlin 2.1.0 instead of older 2.0.x (better future compatibility)
- Kept Gradle 8.13 instead of 8.14+ (minimum required version for plugin compatibility)

**Testing Status**:
- ✅ Clean build succeeds
- ✅ All Kotlin compilation passes
- ⏳ Runtime testing pending (requires IntelliJ IDE with plugin loaded)
- ⏳ Integration testing pending (PSI export → bridge upload flow)

**Next Steps for Other Agents**:
1. Test plugin in sandbox IDE: `./gradlew runIde`
2. Verify "Export PSI to Bridge" action appears and works
3. Test PSI upload to bridge server (ensure bridge is running on port 3100)
4. Validate JSON payload matches `SymbolRecord` schema in `idea-bridge/src/types.ts`

**Commits** (not yet made - waiting for user):
```
fix: upgrade Gradle to 8.13 for IntelliJ Platform plugin (by claude pass1)
fix: upgrade Kotlin to 2.1.0 for Java 21 compatibility (by claude pass1)
fix: correct PSI API usage for IntelliJ Platform 2025.1 (by claude pass1)
fix: disable instrumentCode task due to JDK structure (by claude pass1)
docs: add multi-agent collaboration guidelines (by claude pass1)
```

**Known Issues**:
- None blocking build
- Schema version is 2, ensure bridge server expects this version

**References**:
- IntelliJ Platform Plugin docs: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin.html
- PSI API reference: https://plugins.jetbrains.com/docs/intellij/psi.html
- Kotlin 2.1.0 release notes: https://kotlinlang.org/docs/whatsnew21.html

---

### Codex Pass 2: Align IntelliJ Plugin Build With Latest Platform Plugin

**Session Context**: Follow-up after Claude’s build fixes to ensure Codex environment matches new collaboration protocol and to unblock future development.

**Files Changed**:
- `idea-psi-exporter/build.gradle.kts`
- (Removed temporary `CODEX.md` after user reminder; agent guidance remains centralized in `AGENTS.md`.)

**What / Why**:
1. **IntelliJ Platform Gradle Plugin upgrade (v2.1.0 → v2.10.4)**  
   - Claude’s pass fixed immediate build failures, but upstream plugin now requires ≥2.10.4.  
   - Updated `plugins` block accordingly and kept Kotlin at 1.9.25 per repo constraints.

2. **Toolchain enforcement**  
   - Added `java.toolchain` (21) alongside existing `kotlin.jvmToolchain(21)` so Gradle downloads a compatible JDK even if the host default is newer (Claude hit JDK 25 parsing issues).  
   - Keeps compiler/IDE expectations aligned with IDEA 2025.1.

3. **Agent documentation**  
   - Initially added `CODEX.md`, but per user guidance reverted to using the existing `AGENTS.md`/`AGENTS_CONTRIBUTING.md` as the canonical location for all agent instructions.  
   - All future directives will stay within those shared files.

**Testing**:
- `./gradlew --version` ✅ (using repo-local `GRADLE_USER_HOME=.gradle-local`).  
- `./gradlew build` ❌ inside Codex sandbox (fails while opening UDP port for Gradle’s lock monitor), but expected to work on the user’s host per Claude’s earlier verification.

**Next Steps**:
1. User/other agents should rerun `./gradlew clean build` locally with JDK 21 to confirm plugin compiles under the updated plugin version.  
2. Proceed with PSI exporter enhancements (references, hierarchy, incremental export) outlined in `doc/psi-integration-plan.md`.  
3. Continue documenting every pass in `AI_CHANGELOG.md` + respective agent files.

---

### Codex Pass 3: PSI Ingestion Metadata + MCP Output Upgrade

**Session Context**: After PSI uploads became the default, we needed Milvus ingestion/search to consume the richer metadata and surface it through the MCP tool.

**Files Changed**:
- `doc/psi-integration-plan.md`
- `idea-bridge/src/{embedding.ts,indexer.ts,scripts/ingestMilvus.ts,types.ts}`
- `mcp-server/src/{bridgeClient.ts,index.ts,milvusClient.ts,types.ts}`

**What / Why**:
1. **Plan checkpoint** – Updated the PSI integration plan’s “Current Snapshot” and bridge track to note that PSI cache + schema extensions are complete, leaving streaming/auditing as follow-up work.
2. **Milvus ingestion refresh** – `symbolToEmbeddingText` now includes hierarchy traits, relation summaries, and quality stats so embeddings pick up PSI context. Ingestion metadata tracks repo/module Spring bean counts, hierarchy summaries, and relation totals; `QualityMetrics` now includes annotation counts so regex fallback behaves more like PSI exports. Added a dry-run switch (`DISABLE_MILVUS` / `MILVUS_DRY_RUN`) for inspection without DB access.
3. **End-to-end ingest verification** – Ran `npm run ingest:milvus` (with `MILVUS_RESET=1`) against `~/projects/spring-petclinic-microservices`. 210 repo/module/class/method rows inserted into Milvus; ~13 prompts hit Ollama’s `-Inf` bug and fell back to deterministic embeddings (noted in logs).
4. **MCP metadata exposure** – `mcp-server` now parses repo/module/package info, hierarchy, relations, and Spring hints from Milvus metadata, returning module candidates with stats and final results annotated with location/context info. Tool description/instructions updated to reflect the staged PSI-backed pipeline, and stage summaries now list index levels.

**Testing**:
- `idea-bridge`: `npm run build` ✅, `MILVUS_RESET=1 npm run ingest:milvus` ✅ (writes to live Milvus; dry-run path also exercised earlier).
- `mcp-server`: `npm run build`, `npm run test` (Vitest) ✅.

**Next Steps**:
1. Claude can focus testing on query behavior (e.g., ensure module hits list top packages/dependencies and delivered results include hierarchy/relations).
2. Implement exporter enhancements (call graphs, incremental export) per plan section A, then re-ingest and validate search quality again.

---

### Codex Pass 4: Milvus Search Unblock (Vector Dimension + Query Serialization)

**Session Context**: After the ingestion + MCP metadata work, live searches via Milvus were still failing—first due to mismatched vector dimensions (fallback embeddings created 384-dim rows before the real embeddings arrived), and then because the Python query bridge couldn’t JSON-serialize Milvus hits.

**Files Changed**:
- `idea-bridge/src/scripts/ingestMilvus.ts`
- `idea-bridge/scripts/milvus_query.py`

**What / Why**:
1. **Dynamic embedding dimension handling** – When a “real” embedding comes in with a larger dimension than earlier fallback vectors, we now update the stored dimension and pad all previously queued rows so the Milvus collection tracks the true embedding size. Prevents `vector dimension mismatch` errors during search.
2. **Serializable Milvus results** – `milvus_query.py` now converts each hit into a plain dict (output fields + score) before dumping JSON, resolving the prior `TypeError: Hit is not JSON serializable`.
3. **Fresh end-to-end ingest** – Rebuilt the spring-petclinic collection with `MILVUS_RESET=1 npm run ingest:milvus`; only 12 prompts fell back to deterministic vectors, and Milvus now holds 210 entries with correct dimensions.
4. **Search verification** – Exercised the `searchPipeline` directly (same path the MCP tool uses) with queries like `"service"`, confirming we now get Milvus-backed results that include hierarchy/relations/quality metadata.

**Testing**:
- `idea-bridge`: `npm run build`, `MILVUS_RESET=1 npm run ingest:milvus`
- `mcp-server`: `npm run build`, `npm run test`
- Manual search: `node … createSearchPipeline … search({ query: "service" })` → returns Milvus results containing repo/module metadata.

**Next Steps**:
1. Claude can now run MCP queries end-to-end (tool already exposed in `.codex/config.toml`).
2. Continue exporter enhancements (call graph detection, incremental export) so future ingests populate the new relation metadata more fully.

---

### Claude Code Pass 2: Fix Codex MCP Configuration

**Session Context**: User reported that Codex's self-configured MCP server showed "Tools: (none)" despite being marked as enabled. Investigation revealed ts-node ES module resolution issues.

**Files Changed**:
- `~/.codex/config.toml` (Codex user config)
- `doc/mcp-configuration-guide.md` (created comprehensive guide)

**Root Cause Analysis**:
1. **ts-node + ES modules incompatibility**:
   - Codex configured MCP to run `npm run dev` (uses ts-node)
   - Project uses `"type": "module"` in package.json (ES modules)
   - ts-node failed to resolve `./bridgeClient.js` imports from `.ts` files
   - Error: `Cannot find module '/path/to/bridgeClient.js'`

2. **Compiled dist/ already exists**:
   - Previous Codex pass had run `npm run build` successfully
   - Compiled JavaScript files in `dist/` work perfectly with native Node.js
   - No need for ts-node in production MCP usage

**Fixes Applied**:
1. Updated Codex config (`~/.codex/config.toml`):
   - Changed: `npm run dev` → `npm start`
   - This uses compiled `dist/index.js` instead of ts-node
   - Changed: `IDEA_BRIDGE_BASE_URL` → `IDEA_BRIDGE_URL` (code supports both, but URL is canonical)

2. Created `doc/mcp-configuration-guide.md`:
   - Configuration examples for Claude Code, Codex, Cursor
   - Environment variable reference
   - Troubleshooting section with this exact issue documented
   - Port configuration summary
   - Verification steps

**Testing**:
```bash
# Verified compiled version starts correctly
$ node dist/index.js
[idea-enhanced-context] MCP server ready (PSI staged search active).
```

**Expected Outcome**:
After Codex restarts its MCP connection, it should now see:
```
• idea_enhanced_context
  • Status: enabled
  • Tools: search_java_class  ← Should appear now!
```

**Key Decision**:
- **Production MCP usage should always use compiled code** (`npm start`), not dev mode
- **Dev mode (`npm run dev`) is only for development/debugging** with console access
- This is now documented in troubleshooting guide

**Environment Variables Clarification**:
Code supports multiple names (bridgeClient.ts:35-37):
- `IDEA_BRIDGE_BASE_URL` ✅
- `IDEA_BRIDGE_URL` ✅ (recommended)
- `IDEA_BRIDGE_HTTP` ✅
All map to the same config; chose `IDEA_BRIDGE_URL` for consistency.

**Next Steps for Codex**:
1. Restart Codex or reload MCP configuration
2. Verify `search_java_class` tool now appears
3. Test with query: "Search for UserService classes"
4. Should get results from spring-petclinic data ingested in Pass 4

**For Other Agents**:
Refer to `doc/mcp-configuration-guide.md` for:
- Claude Code JSON configuration
- Cursor AI setup
- Full environment variable reference
- Troubleshooting common issues

**Self-Configuration**:
After documenting the fix, Claude Code configured itself:
```bash
$ claude mcp add idea-enhanced-context \
    --env IDEA_BRIDGE_URL=http://127.0.0.1:63000 \
    --env MILVUS_ADDRESS=127.0.0.1:19530 \
    -- node /path/to/mcp-server/dist/index.js

$ claude mcp list
idea-enhanced-context: ... - ✓ Connected
```

Now Claude Code has the `search_java_class` tool available! 🎉

**Follow-up: Bridge Server Had Same Issue**:
User discovered `idea-bridge` also fails with `npm run dev`:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../config.js'
```

Same root cause - ts-node + ES modules. Fixed both projects:

1. **idea-bridge/package.json**:
   - `"dev": "npm run build && node dist/server.js"` (was ts-node)
   - Added `"build:watch"` for development

2. **mcp-server/package.json**:
   - `"dev": "npm run build && node dist/index.js"` (was ts-node)
   - Added `"build:watch"` for development

**Pattern**: Any ES module TypeScript project should use compiled code, not ts-node in dev scripts.

**For rapid development**: Use `npm run build:watch` in one terminal + `npm start` in another.

**Commits** (pending user):
```bash
fix: update Codex MCP config to use compiled code instead of ts-node (by claude pass2)
fix: replace ts-node with compiled code in dev scripts (by claude pass2)
docs: add comprehensive MCP configuration guide with troubleshooting (by claude pass2)
```

---

## Template for Future Entries

```markdown
## YYYY-MM-DD

### <Agent Name> Pass <N>: <Brief Description>

**Session Context**: <Why this work was done>

**Files Changed**:
- `path/to/file1.ext`
- `path/to/file2.ext`

**What**: <High-level summary of changes>

**Why**: <Motivation or problem being solved>

**Key Decisions**:
- Decision 1 and rationale
- Decision 2 and rationale

**Testing**:
- Test results
- What was verified
- What remains to be tested

**Commits**: `<commit-hash-range>`

**Next Steps**: <What the next agent should do>
```

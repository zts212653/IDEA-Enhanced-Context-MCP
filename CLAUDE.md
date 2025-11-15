# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚠️ IMPORTANT: Multi-Agent Collaboration Rules

**BEFORE starting any work, ALWAYS read:**
- **`AGENTS_CONTRIBUTING.md`** - Mandatory guidelines for AI collaboration
- **`AI_CHANGELOG.md`** - Recent changes by other AI agents (Codex, etc.)
- **`AGENTS.md`** - Repository-specific workflow & configuration tips
- Run `git status` and `git log --oneline -5` to see current state

**Key Rules:**
1. **Git is the single source of truth** - Don't trust chat memory
2. **No large refactoring without permission** - Ask first
3. **Write failing tests before fixing bugs** - Lock bugs with tests
4. **Never hide errors** - No empty catch blocks or commented tests
5. **Attribute all commits** - Use format: `fix: description (by claude pass1)`
6. **Follow the Backlog loop** - Implement → Self-test → Update docs → Tick BACKLOG → Log in AI_CHANGELOG
7. **Feature completion ritual** - When claiming "milestone done", run build → stage → commit → push → verify

See `AGENTS_CONTRIBUTING.md` for complete protocol.

---

## Project Overview

IDEA-Enhanced-Context is an MCP (Model Context Protocol) server that provides enterprise-grade Java code search using IntelliJ IDEA's PSI (Program Structure Interface) semantic index. The system consists of three main components:

1. **IntelliJ Plugin** (`idea-psi-exporter/`) - Kotlin plugin that exports PSI metadata from IDEA
2. **Bridge Server** (`idea-bridge/`) - TypeScript/Fastify server that receives PSI uploads and provides search API
3. **MCP Server** (`mcp-server/`) - TypeScript MCP server that orchestrates staged search with context budgeting

The key architectural insight is leveraging IDEA's existing semantic index rather than rebuilding from scratch, providing superior Java/Kotlin type inference, cross-file references, and Spring framework integration.

## Development Commands

### IntelliJ Plugin (`idea-psi-exporter/`)
```bash
cd idea-psi-exporter
./gradlew build                    # Build the plugin
./gradlew runIde                   # Launch IDEA with plugin in sandbox
```
The plugin action "Export PSI to Bridge" becomes available after loading. It collects Java classes/interfaces with their methods, fields, annotations, and uploads to the bridge server.

### Bridge Server (`idea-bridge/`)
```bash
cd idea-bridge
npm run build                      # Compile TypeScript
npm run dev                        # Build and run (uses compiled code)
npm run build:watch                # Auto-recompile on changes
npm run start                      # Run compiled version without rebuilding
npm run index:symbols              # Build symbol index via regex (legacy fallback)
npm run ingest:milvus              # Push symbols to Milvus vector DB
npm test                           # Run tests (currently minimal)
```

**⚠️ Important**: This is an ES module project. `dev` script uses compiled code, NOT ts-node. For rapid development, run `npm run build:watch` in one terminal and `npm start` in another.

**Key endpoints:**
- `POST /api/psi/upload` - Accepts PSI payloads from plugin, swaps in-memory index
- `GET /api/symbols/search?query=...&module=...` - Search symbols via MiniSearch
- `GET /api/symbols/:fqn` - Get specific symbol details
- `GET /healthz` - Health check

### MCP Server (`mcp-server/`)
```bash
cd mcp-server
npm run build                      # Compile TypeScript
npm run dev                        # Build and run (uses compiled code)
npm run build:watch                # Auto-recompile on changes
npm run start                      # Run compiled version without rebuilding
npm run typecheck                  # TypeScript validation without emit
npm test                           # Run Vitest tests
npm run test:watch                 # Vitest in watch mode
```

**⚠️ Important**: This is an ES module project. `dev` script uses compiled code, NOT ts-node.

The MCP server exposes `search_java_class` tool via stdio transport. Configure in Claude Desktop/Code by adding to MCP settings (see `doc/mcp-configuration-guide.md`).

## MCP Testing & Troubleshooting

When running MCP queries locally, corporate proxies may break gRPC connections to Milvus. See `doc/mcp-grpc-troubleshooting.md` for:
- How to clear proxy env vars before running tests
- The exact command: `source .venv/bin/activate && DISABLE_SCHEMA_CHECK=1 npm run tool:search -- "<query>"`
- Context budget testing with `MAX_CONTEXT_TOKENS=4000`
- Scenario-based evaluation using `scripts/run_eval.mjs`

## Architecture Highlights

### Three-Tier Data Flow

```
IntelliJ IDEA PSI → Plugin Export → Bridge Server (/api/psi/upload)
                                   ↓
                            MiniSearch Index (in-memory)
                                   ↓
                            Embedding Generation → Milvus
                                   ↓
                            MCP Server (staged search)
                                   ↓
                            Claude Code
```

### Multi-Level Indexing Strategy

The system implements a **three-level staged search** (documented in `doc/embedding-layer.md`):

1. **Repository Level** - Coarse-grained discovery across repos
2. **Module Level** - Maven/Gradle module filtering (reduces search space dramatically)
3. **Class/Method Level** - Fine-grained semantic search within selected modules

Each level uses `index_level` metadata field in Milvus to enable progressive filtering, preventing context explosion when searching across 10,000+ repositories.

### PSI Schema (`idea-bridge/src/types.ts`)

The `SymbolRecord` interface is the single source of truth for PSI data. Key fields:

- **Identity**: `fqn` (fully qualified name), `kind` (CLASS/INTERFACE), `module`, `packageName`
- **Structure**: `methods[]`, `fields[]`, `annotations[]`, `modifiers[]`
- **Relationships**: `implements[]`, `extends[]`, `dependencies`, `hierarchy`, `relations` (calls/calledBy/references)
- **Spring Integration**: `springInfo` (bean detection, autowired dependencies)
- **Quality Signals**: `quality.hasJavadoc`, `quality.methodCount` (used for reranking)

The schema is **versioned** via `schemaVersion` field to handle evolution.

### Context Budget Management

`mcp-server/src/searchPipeline.ts:applyContextBudget()` enforces token limits (default 8000) by:
1. Prioritizing module-level summaries over class details
2. Estimating tokens as ~4 chars/token for code
3. Returning `deliveredResults` (within budget) + `omittedCount`

This prevents overwhelming Claude with 100+ classes when only 10-15 are relevant.

## Current State vs Future (See `doc/psi-integration-plan.md`)

**What Works Now (MVP)**:
- Plugin exports basic class/method metadata (batch size 500)
- Bridge accepts uploads and swaps in-memory index
- MCP server provides staged search with fallback to mock data
- PSI cache (`idea-bridge/.idea-bridge/psi-cache.json`) persists across restarts

**Key Gaps Being Addressed**:
- Reference graphs (callers/callees) - collector scaffolded but not fully implemented
- Incremental exports - currently manual action, need file change listeners
- Embedding quality - still uses simple summaries, needs PSI-rich context
- UI for bridge URL configuration in plugin settings

## Important Configuration

### Environment Variables

**Bridge Server**:
- `BRIDGE_HOST` - Listen address (default: 127.0.0.1)
- `BRIDGE_PORT` - Port (default: 3100)
- `IDEA_PROJECT_ROOT` - For regex fallback indexing
- `PSI_CACHE_PATH` - Cache location (default: `.idea-bridge/psi-cache.json`)

**MCP Server**:
- `IDEA_BRIDGE_URL` - Bridge endpoint (default: `http://127.0.0.1:3100`)
- `MILVUS_ADDRESS` - Milvus gRPC endpoint (default: `127.0.0.1:19530`)
- `MILVUS_COLLECTION` - Collection name (default: `java_code_multilevel`)
- `OLLAMA_BASE_URL` / `OLLAMA_MODEL` - For local embeddings

### Testing Reference Repository

Use `~/projects/spring-petclinic-microservices` for validation (per `doc/psi-integration-plan.md`):
1. Open in IntelliJ
2. Run "Export PSI to Bridge" action
3. Verify upload to bridge (check logs)
4. Run `npm run ingest:milvus` in bridge directory
5. Test MCP search tool with queries like "Spring beans", "repository usages"

## Code Style Conventions

**TypeScript** (`idea-bridge/`, `mcp-server/`):
- 2-space indentation
- ES module syntax (`import`/`export`)
- Explicit return types for exported functions
- Run `npm run typecheck` before committing

**Kotlin** (`idea-psi-exporter/`):
- 4-space indentation (JetBrains defaults)
- PascalCase for classes, camelCase for functions
- Use IntelliJ's built-in formatter

**JSON Payloads**:
- ASCII-only keys (avoid Unicode in field names)
- Must validate against `SymbolRecord` interface in `idea-bridge/src/types.ts`

## Testing Strategy

- **mcp-server**: Vitest tests in `*.test.ts` files (colocated with source)
- **idea-bridge**: Currently relies on manual testing via curl/Postman for `/api/psi/upload`
- **plugin**: Manual testing in sandbox IDE (no automated tests yet)

**Recommended test flow**:
1. `./gradlew build` in plugin directory
2. `npm test` in mcp-server
3. `npm run build && npm run ingest:milvus` in bridge (integration test)

## Git Workflow

This project follows **Conventional Commits**:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring

Recent commits show this pattern (e.g., `feat: scaffold PSI exporter plugin and bridge upload API`).

**Current branch**: `mvp` (merges to `main` for production)

## Critical Files to Understand

1. **`doc/psi-integration-plan.md`** - Single source of truth for PSI enrichment roadmap
2. **`doc/embedding-layer.md`** - Multi-level indexing and context budgeting strategy
3. **`idea-bridge/src/types.ts`** - PSI schema definition (version 2)
4. **`mcp-server/src/searchPipeline.ts`** - Staged search orchestration logic
5. **`idea-psi-exporter/src/main/kotlin/com/idea/enhanced/psi/PsiCollectors.kt`** - PSI extraction logic

## Local Development Setup

Requires:
- **Java 21** (for IntelliJ plugin development)
- **Node.js 18+** (for TypeScript projects)
- **Milvus 2.4+** (for vector search, via Docker recommended)
- **Ollama** (optional, for local embeddings instead of OpenAI/Voyage)

Quick start:
```bash
# Terminal 1: Start dependencies
docker compose up -d milvus ollama

# Terminal 2: Bridge server
cd idea-bridge && npm install && npm run dev

# Terminal 3: MCP server (for Claude Code)
cd mcp-server && npm install && npm run build

# Terminal 4: Plugin development
cd idea-psi-exporter && ./gradlew runIde
```

Refer to `doc/local-setup-guide.md` for detailed dependency installation.

## Known Limitations

- **Node.js Milvus SDK constraints**: Some gRPC operations unstable, Python helper scripts used as fallback (see `doc/milvus-node-connectivity.md`)
- **Schema evolution**: Version 2 adds Spring/hierarchy/relations fields but not all collectors implemented yet
- **Performance**: Regex fallback indexing is slow for large repos (>5000 classes), PSI export preferred
- **Incremental updates**: Currently manual action trigger, file change listeners planned

## Monorepo Context

Despite three separate npm/gradle projects, this is treated as a **monorepo** with shared documentation in `doc/`. When making changes across components, update the relevant design doc (e.g., schema changes require updating `psi-integration-plan.md`).

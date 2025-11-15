# AI Agents Contributing Guidelines

This document establishes rules for AI assistants (Codex, Claude Code, etc.) working on this codebase to ensure consistent, safe, and traceable collaboration.

## Core Principle: Git Repository is the Single Source of Truth

**ALL AI agents MUST treat the current working branch's file content as the authoritative source.**

### Before Any Analysis or Modification

1. **Always check current state first:**
   ```bash
   git status
   git log --oneline -5
   git diff
   ```

2. **Read key files from disk, never rely on:**
   - Chat history memory
   - Previous conversations
   - Assumptions about "what should be there"

3. **Verify your understanding:**
   - If unsure about a design decision, check `doc/` folder
   - Check `AI_CHANGELOG.md` for recent AI modifications
   - Read commit messages to understand recent changes

## Refactoring Rules

### ❌ FORBIDDEN Without Explicit Permission

- **Large-scale refactoring** (renaming packages, moving directory structures)
- **Changing API contracts** without backward compatibility plan
- **Modifying core data structures** (e.g., `SymbolRecord` schema) without updating all consumers

### ✅ ALLOWED Refactoring

- Local code cleanup within a single file
- Extracting small helper functions
- Fixing obvious bugs with clear tests

### 📋 Required Process for Major Refactoring

If major refactoring is truly needed:

1. **Document the plan first:**
   - Create a design doc in `doc/refactor-[feature-name].md`
   - List all affected files and components
   - Describe migration path

2. **Get explicit confirmation:**
   - Ask the user: "This requires refactoring X, Y, Z. Should I proceed?"
   - Wait for approval before making changes

3. **Execute incrementally:**
   - Make changes in small, testable steps
   - Commit after each logical unit
   - Run tests between steps

## Testing Requirements

### Bug Fixing Protocol

**ALWAYS follow this sequence:**

1. **Write a failing test first:**
   ```kotlin
   @Test
   fun `should handle empty PSI class list`() {
       val result = collector.collect(emptyList())
       assertEquals(0, result.size)  // This MUST fail before fix
   }
   ```

2. **Fix the code** to make the test pass

3. **Verify:**
   ```bash
   npm test  # or ./gradlew test
   ```

### Why This Matters

- Tests become "executable memory" for future AI sessions
- Prevents regression when other agents modify code
- Makes bug fixes verifiable and reproducible

## Anti-Patterns: Forbidden "Bug Hiding" Practices

### ❌ NEVER Do These

```kotlin
// ❌ Silently swallowing exceptions
try {
    riskyOperation()
} catch (Exception e) {
    // Empty catch - FORBIDDEN
}

// ❌ Commenting out failing tests
// @Test
// fun testThatFails() { ... }

// ❌ Removing assertions to make tests pass
// assertEquals(expected, actual)  // Commented out
```

### ✅ Correct Approaches

```kotlin
// ✅ Proper error handling
try {
    riskyOperation()
} catch (Exception e) {
    logger.error("Operation failed: ${e.message}", e)
    throw IllegalStateException("Cannot proceed without X", e)
}

// ✅ Fixing the root cause
@Test
fun testThatFails() {
    // Fixed the underlying issue
    assertEquals(expected, actual)
}

// ✅ Explicit TODO if can't fix immediately
@Test
@Disabled("TODO: Fix after schema migration (issue #123)")
fun testPendingFix() { ... }
```

## Commit Message Convention

Every AI modification MUST be committed with a clear attribution:

### Format

```
<type>: <description> (by <agent> <pass-number>)

<optional detailed explanation>
```

### Examples

```bash
# Codex makes initial implementation
git commit -m "feat: implement PSI hierarchy collector (by codex pass1)"

# Claude fixes a bug
git commit -m "fix: correct extendsListTypes API usage (by claude pass1)

- Changed from deprecated extendsTypes to extendsListTypes
- Fixed PsiDocCommentOwner cast in extractDoc()
- Refs: IntelliJ Platform SDK migration guide"

# Codex continues development
git commit -m "feat: add Spring bean detection (by codex pass2)"
```

### Agent Identifiers

- `codex` - GitHub Copilot / OpenAI Codex
- `claude` - Claude Code (Anthropic)
- `cursor` - Cursor AI
- `other` - Other AI assistants

## AI_CHANGELOG.md

**Location**: `/AI_CHANGELOG.md` (root of repo)

**Purpose**: High-level log of AI contributions for cross-session awareness

### Format

```markdown
# AI Changelog

## 2025-11-14

### Claude Code Pass 1 (Build Fixes)
- **Files Changed**: `build.gradle.kts`, `PsiCollectors.kt`, `ExportPsiAction.kt`
- **What**: Fixed compilation errors from Kotlin 1.9.25 → 2.1.0 migration
- **Why**: Original code used deprecated PSI APIs
- **Key Decisions**:
  - Disabled instrumentCode task due to JDK Packages directory issue
  - Updated to extendsListTypes API
- **Commits**: `abc123..def456`

### Codex Pass 3 (PSI Export)
- **Files Changed**: `PsiCollectors.kt`, `SymbolBuilder`
- **What**: Implemented hierarchy and Spring info extraction
- **Why**: Needed for semantic search quality
- **Key Decisions**:
  - Used whitelist approach for Spring bean detection
  - Deferred call graph collection to later phase
- **Commits**: `789abc..012def`
```

## Cross-Agent Handoff Protocol

### When Starting a New Session

1. **Read these files in order:**
   ```bash
   # 1. Check what branch you're on
   git status

   # 2. Read AI activity log
   cat AI_CHANGELOG.md

   # 3. Check recent commits
   git log --oneline -10

   # 4. Read current issues
   cat CLAUDE.md  # or AGENTS.md
   ```

2. **Understand context before acting:**
   - What was the last agent working on?
   - Are there any known issues or TODOs?
   - What's the current build status?

3. **Verify assumptions:**
   ```bash
   # Run tests to see current state
   npm test  # or ./gradlew test

   # Try building
   npm run build  # or ./gradlew build
   ```

### When Ending a Session

1. **Update AI_CHANGELOG.md** with your contributions

2. **Create clear commits** with agent attribution

3. **Leave breadcrumbs:**
   - Add TODO comments for incomplete work
   - Update relevant `doc/*.md` files
   - Note any blockers or decisions in CHANGELOG

## Schema Evolution Protocol

The `SymbolRecord` interface in `idea-bridge/src/types.ts` is the **contract** between components.

### When Modifying SymbolRecord

1. **Check all consumers:**
   ```bash
   # Find all usages
   git grep "SymbolRecord" --name-only
   ```

2. **Required updates (ALL must be done together):**
   - `idea-bridge/src/types.ts` - TypeScript interface
   - `idea-psi-exporter/src/.../PsiCollectors.kt` - Kotlin data class
   - `mcp-server/src/types.ts` - MCP server types
   - `doc/psi-integration-plan.md` - Documentation

3. **Version bump:**
   ```kotlin
   // In PsiCollectors.kt
   private const val SCHEMA_VERSION = 3  // Increment!
   ```

4. **Migration path:**
   - Add backward compatibility handling in bridge server
   - Document breaking changes in `AI_CHANGELOG.md`

## File Organization Rules

### Don't Move These Without Discussion

- `idea-bridge/src/types.ts` - PSI schema definitions
- `doc/psi-integration-plan.md` - Single source of truth for roadmap
- `doc/embedding-layer.md` - Multi-level indexing strategy

### Safe to Modify

- Test files (`*.test.ts`, `*Test.kt`)
- Script files (`scripts/`)
- Build configuration (with caution)

## Testing Before Commit

### Minimum Verification

```bash
# For TypeScript changes
cd idea-bridge && npm run typecheck && npm test
cd mcp-server && npm run typecheck && npm test

# For Kotlin changes
cd idea-psi-exporter && ./gradlew build

# For cross-component changes - test integration
cd idea-bridge && npm run build && npm run ingest:milvus
```

### Integration Test Flow

```bash
# 1. Start bridge server
cd idea-bridge && npm run dev &

# 2. In IntelliJ with plugin loaded:
#    Run "Export PSI to Bridge" action

# 3. Verify upload
curl http://127.0.0.1:3100/api/info

# 4. Test MCP search
cd mcp-server && npm run dev
# Use MCP Inspector or Claude Code to test search
```

## Communication with User

### When to Ask for Clarification

- Ambiguous requirements
- Multiple valid implementation approaches
- Breaking changes needed
- Uncertainty about design decisions

### When to Proceed Autonomously

- Fixing obvious bugs (with tests)
- Implementing well-specified features
- Refactoring within single file scope
- Updating documentation

### Format for Reporting Changes

```markdown
## Changes Made

### Fixed Issues
1. **Build failure in idea-psi-exporter** (build.gradle.kts:3)
   - Upgraded Kotlin from 1.9.25 → 2.1.0
   - Reason: Version parsing incompatibility with Java 21

2. **API usage errors** (PsiCollectors.kt:58-59)
   - Changed `extendsTypes` → `extendsListTypes`
   - Reason: Deprecated API in IntelliJ Platform 2025.1

### Verification
- ✅ `./gradlew clean build` succeeds
- ✅ All existing tests pass
- ✅ No new warnings introduced

### Next Steps
- [ ] Test plugin in sandbox IDE
- [ ] Verify PSI export uploads to bridge successfully
```

## Emergency Rollback Procedure

If an AI agent introduces breaking changes:

```bash
# 1. Identify the problematic commits
git log --oneline -20

# 2. Revert specific commits (safest)
git revert <commit-hash>

# 3. Or reset to known good state
git reset --hard <good-commit-hash>

# 4. Document in AI_CHANGELOG.md
echo "## ROLLBACK: Reverted commits xyz due to [reason]" >> AI_CHANGELOG.md
```

## Summary: The Golden Rules

1. **Git is truth** - Always check current file state first
2. **Test, then fix** - Write failing test before fixing bugs
3. **No silent failures** - Never hide errors with empty catch blocks
4. **Attribute changes** - Every commit mentions which AI made it
5. **Document decisions** - Update AI_CHANGELOG.md and relevant docs
6. **Ask before refactoring** - Big changes need explicit approval
7. **Verify before committing** - Run tests and builds
8. **Leave breadcrumbs** - Help the next agent understand context

---

**Version**: 1.0
**Last Updated**: 2025-11-14
**Maintained By**: All contributing AI agents and human maintainers

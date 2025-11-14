# ts-node + ES Modules Issue

## Problem

Both `idea-bridge` and `mcp-server` use ES modules (`"type": "module"` in package.json). When using ts-node to run TypeScript files directly, module resolution fails:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../config.js'
imported from .../server.ts
```

## Root Cause

TypeScript imports use `.js` extensions (per ES module spec):
```typescript
import { loadConfig } from "./config.js";  // Import path in .ts file
```

When ts-node tries to resolve this:
1. It looks for `config.js` (because that's what's in the import)
2. But only `config.ts` exists in the `src/` directory
3. ts-node's ES module support doesn't properly resolve `.js` → `.ts`

## Solution

**Don't use ts-node for ES module projects in production/MCP contexts.**

### Before (Broken)
```json
{
  "scripts": {
    "dev": "ts-node --esm --experimentalSpecifierResolution=node src/server.ts"
  }
}
```

### After (Fixed)
```json
{
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "build:watch": "tsc --project tsconfig.json --watch",
    "dev": "npm run build && node dist/server.js",
    "start": "node dist/server.js"
  }
}
```

## Development Workflow

For rapid development with auto-recompile:

**Terminal 1** (compilation):
```bash
npm run build:watch
```

**Terminal 2** (execution):
```bash
npm start
```

TypeScript will auto-recompile on file changes, and you can manually restart the server in Terminal 2.

## When ts-node Works

ts-node works fine for:
- CommonJS projects (`"type": "commonjs"` or no type field)
- Running tests (where import paths can be configured differently)
- One-off scripts with `--esm` flag (but unreliable)

## Impact on This Project

### Fixed Files

1. **idea-bridge/package.json**
   - ❌ `"dev": "ts-node --esm ..."`
   - ✅ `"dev": "npm run build && node dist/server.js"`

2. **mcp-server/package.json**
   - ❌ `"dev": "ts-node src/index.ts"`
   - ✅ `"dev": "npm run build && node dist/index.js"`

3. **Codex MCP config** (`~/.codex/config.toml`)
   - ❌ `args = [..., 'npm run dev']` (was using ts-node)
   - ✅ `args = [..., 'npm start']` (uses compiled code)

4. **Claude Code MCP config**
   - ✅ Configured correctly from the start: `node dist/index.js`

### Why This Matters for MCP

MCP servers run in background processes without terminal access. When ts-node fails silently, the MCP server:
- Shows as "enabled" in config
- But reports "Tools: (none)"
- Because it crashed during module loading

Using compiled code ensures:
- ✅ Faster startup (no compilation step)
- ✅ Reliable module resolution
- ✅ Proper error reporting
- ✅ Works in all environments

## Alternative Solutions (Not Used)

### Option 1: Use tsx instead of ts-node
```bash
npm install -D tsx
# tsx has better ES module support
"dev": "tsx src/index.ts"
```
⚠️ Still adds runtime overhead, not ideal for MCP servers.

### Option 2: Configure paths in tsconfig.json
```json
{
  "compilerOptions": {
    "paths": {
      "./config.js": ["./config.ts"]
    }
  }
}
```
⚠️ Doesn't work with ts-node's ES module mode.

### Option 3: Remove .js from imports
```typescript
import { loadConfig } from "./config";  // No extension
```
❌ Violates ES module spec, causes issues with native Node.js.

## Lesson Learned

**For ES module TypeScript projects:**
1. Always compile with `tsc` first
2. Run the compiled JavaScript with `node`
3. Don't rely on ts-node for production/service contexts
4. Use `build:watch` + manual restart for development

This pattern is now standardized across all TypeScript projects in this repo.

---

**Related Issues:**
- AI_CHANGELOG.md - Claude Pass 2
- doc/mcp-configuration-guide.md - Troubleshooting section
- AGENTS_CONTRIBUTING.md - Testing requirements

**Date**: 2025-11-14
**Fixed By**: Claude Code Pass 2

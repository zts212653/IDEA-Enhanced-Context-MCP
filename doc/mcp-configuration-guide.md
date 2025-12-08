# MCP Server Configuration Guide

This guide explains how to configure different AI tools (Claude Code, Codex, etc.) to use the IDEA-Enhanced-Context MCP server.

## Prerequisites

1. **Build the MCP server:**
   ```bash
   cd mcp-server
   npm install
   npm run build
   ```

2. **Start the bridge server:**
   ```bash
   cd idea-bridge
   npm install
   npm run dev  # or npm start
   ```

3. **Optional: Start Milvus (for vector search):**
   ```bash
   docker run -d --name milvus \
     -p 19530:19530 \
     -p 9091:9091 \
     milvusdb/milvus:latest
   ```

## Configuration by Tool

### Claude Code (Anthropic)

**Recommended: Using CLI (Easiest)**

```bash
claude mcp add idea-enhanced-context \
  --env IDEA_BRIDGE_URL=http://127.0.0.1:63000 \
  --env MILVUS_ADDRESS=127.0.0.1:19530 \
  -- node /Users/lysander/projects/IDEA-Enhanced-Context-MCP/mcp-server/dist/index.js
```

Verify:
```bash
claude mcp list
# Should show: idea-enhanced-context: ... - ✓ Connected
```

**Alternative: Manual JSON Configuration**

**Location**: `~/.config/claude/claude_desktop_config.json` (Linux/macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "idea-enhanced-context": {
      "command": "node",
      "args": [
        "/Users/lysander/projects/IDEA-Enhanced-Context-MCP/mcp-server/dist/index.js"
      ],
      "env": {
        "IDEA_BRIDGE_URL": "http://127.0.0.1:63000",
        "MILVUS_ADDRESS": "127.0.0.1:19530"
      }
    }
  }
}
```

### Codex (via .codex/config.toml)

**Location**: `~/.codex/config.toml`

```toml
[mcp_servers.idea_enhanced_context]
command = '/bin/bash'
args = ['-lc', 'cd /Users/lysander/projects/IDEA-Enhanced-Context-MCP/mcp-server && npm start']

[mcp_servers.idea_enhanced_context.env]
IDEA_BRIDGE_URL = 'http://127.0.0.1:63000'
MILVUS_ADDRESS = '127.0.0.1:19530'
```

**⚠️ Important**: Use `npm start` (compiled version), NOT `npm run dev` (ts-node). The `dev` script has ES module resolution issues.

### Cursor AI

**Location**: Check Cursor's MCP settings (typically in settings/preferences)

Format is similar to Claude Code's JSON configuration.

## Environment Variables

The MCP server supports the following environment variables:

### Bridge Connection

- `IDEA_BRIDGE_URL` - Bridge server base URL (default: `http://127.0.0.1:63000`).
- `IDEA_BRIDGE_BASE_URL` / `IDEA_BRIDGE_HTTP` - Alternative names for bridge URL.
- `BRIDGE_PSI_CACHE` - Explicit PSI cache file；或使用 `BRIDGE_PSI_CACHE_DIR` 让 Bridge 按 `psi-cache-<project>.json` 保存在指定目录（默认 `.idea-bridge/`）。
- `BRIDGE_BODY_LIMIT` - Maximum upload payload size in bytes (default: `50 * 1024 * 1024`). Increase this if PSI export batches trigger `413 Payload Too Large`.
- `INGEST_LIMIT` - Optional cap on symbol count during `npm run ingest:milvus`; useful for smoke tests on very large projects before attempting full ingest.
- `NODE_OPTIONS="--max-old-space-size=8192"` - Increase Node heap if ingest crashes with `RangeError: Invalid string length` while stringifying the Milvus payload.
 - `INGEST_MODULE_FILTER` - Comma-separated list of module names (e.g. `spring-aop,spring-context`) to restrict ingest to specific modules for focused experiments.

### Milvus Vector Database

- `MILVUS_ADDRESS` - Milvus server address (default: `127.0.0.1:19530`)
- `MILVUS_COLLECTION` - Collection name (default: `java_code_multilevel`)
- `MILVUS_USERNAME` - Optional authentication username
- `MILVUS_PASSWORD` - Optional authentication password

### Embedding Configuration

- `OLLAMA_BASE_URL` - Ollama API endpoint (for local embeddings)
- `OLLAMA_MODEL` - Ollama embedding model name
- `OPENAI_API_KEY` - For OpenAI embeddings (if not using Ollama)
- `EMBEDDING_PROVIDER` / `EMBEDDING_HOST` / `EMBEDDING_MODEL` - generic embedding selector; set provider to `jina` + host/model to target the lightweight Jina server.

### Jina embedding server（本地）

**前台启动（便于看日志）**
```bash
cd /Users/lysander/projects/IDEA-Enhanced-Context-MCP
source .venv/bin/activate
HF_HOME=~/.cache/hf_jina_clean TRANSFORMERS_CACHE=~/.cache/hf_jina_clean \
HF_HUB_ENABLE_HF_TRANSFER=1 HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
HOST=127.0.0.1 PORT=7997 MODEL=jinaai/jina-embeddings-v3 DEVICE=mps \
python scripts/jina_server.py
```
- 日志包含 `[jina-server] embedding ...`，Uvicorn info 级别。

**后台运行**
```bash
source .venv/bin/activate
HF_HOME=~/.cache/hf_jina_clean TRANSFORMERS_CACHE=~/.cache/hf_jina_clean \
HF_HUB_ENABLE_HF_TRANSFER=1 HF_HUB_DISABLE_SYMLINKS_WARNING=1 \
HOST=127.0.0.1 PORT=7997 MODEL=jinaai/jina-embeddings-v3 DEVICE=mps \
nohup python scripts/jina_server.py > /tmp/jina_server.log 2>&1 &
```
- 查看日志：`tail -f /tmp/jina_server.log`
- 停止：`pkill -f jina_server.py`

**入库时确保走 Jina（避免 OLLAMA_HOST 抢优先级）**
```bash
PATH=/Users/lysander/projects/IDEA-Enhanced-Context-MCP/.venv/bin:$PATH \
BRIDGE_PSI_CACHE=.idea-bridge/psi-cache-spring-framework.json \
MILVUS_COLLECTION=idea_symbols_spring_jina \
EMBEDDING_PROVIDER=jina \
EMBEDDING_HOST=http://127.0.0.1:7997 \
EMBEDDING_MODEL=jinaai/jina-embeddings-v3 \
OLLAMA_HOST= OLLAMA_MODEL= \
EMBED_LOG_EVERY=200 \
npm run ingest:milvus
```
ingest 开头会打印 provider/model，每 `EMBED_LOG_EVERY` 条打印一次进度。

## Verification

### 1. Check MCP Server Startup

```bash
cd mcp-server
npm start
```

You should see:
```
[idea-enhanced-context] MCP server ready (PSI staged search active).
```

Press Ctrl+C to stop.

### 2. Test Bridge Connection

```bash
curl http://127.0.0.1:63000/healthz
```

Should return: `{"status":"ok"}`

### 3. Test MCP Tool Registration

After configuring your AI tool, check if the tool appears:

- **Claude Code**: The tool `search_java_class` should appear in the tool list
- **Codex**: Run `/mcp-tools` to list available tools

### 4. Test End-to-End Search

Ask your AI tool:
```
Use the search_java_class tool to find "UserService" classes
```

You should get results with Java class metadata.

## Troubleshooting

### Problem: "Tools: (none)" in MCP Server Status

**Cause**: Using `npm run dev` which has ES module resolution issues with ts-node.

**Fix**: Change to `npm start` in your config:
```toml
# ❌ Wrong
args = ['-lc', 'cd /path/to/mcp-server && npm run dev']

# ✅ Correct
args = ['-lc', 'cd /path/to/mcp-server && npm start']
```

Then rebuild:
```bash
cd mcp-server && npm run build
```

### Problem: "Cannot find module bridgeClient.js"

**Cause**: The `dist/` folder is missing or outdated.

**Fix**:
```bash
cd mcp-server
npm run build
```

### Problem: "Connection refused" to Bridge

**Cause**: Bridge server is not running or wrong port.

**Fix**:
1. Start bridge server:
   ```bash
   cd idea-bridge && npm run dev
   ```

2. Verify port in bridge config:
   ```bash
   grep BRIDGE_PORT idea-bridge/.env
   ```

3. Update MCP config to match:
   ```bash
   IDEA_BRIDGE_URL="http://127.0.0.1:3100"  # If bridge uses 3100
   ```

### Problem: "Milvus connection failed"

**Symptoms**: Search still works but uses fallback mode, no vector search.

**Cause**: Milvus not running or wrong address.

**Fix**:
1. Check if Milvus is running:
   ```bash
   docker ps | grep milvus
   ```

2. Start Milvus if needed:
   ```bash
   docker start milvus
   # or
   cd idea-bridge && docker compose up -d milvus
   ```

3. Verify connection:
   ```bash
   curl http://127.0.0.1:9091/healthz
   ```

### Problem: Tool works but returns empty results

**Cause**: No data has been ingested to bridge/Milvus.

**Fix**:
1. Export PSI from IntelliJ plugin (Run "Export PSI to Bridge" action)

2. Or use regex fallback indexing:
   ```bash
   cd idea-bridge
   IDEA_PROJECT_ROOT=~/projects/your-java-project npm run index:symbols
   ```

3. Ingest to Milvus:
   ```bash
   cd idea-bridge
   npm run ingest:milvus
   ```

## Port Configuration Summary

| Service | Default Port | Config Location | Environment Variable |
|---------|--------------|-----------------|---------------------|
| Bridge Server | 3100 or 63000 | `idea-bridge/.env` | `BRIDGE_PORT` |
| MCP Server | stdio | N/A (uses stdio) | N/A |
| Milvus gRPC | 19530 | Docker / MCP env | `MILVUS_ADDRESS` |
| Milvus HTTP | 9091 | Docker | N/A |
| Ollama | 11434 | System | `OLLAMA_BASE_URL` |

## Advanced: Multiple Projects

To use the MCP server with different projects:

1. **Option A: Multiple MCP server instances**
   ```json
   {
     "mcpServers": {
       "project-a-context": {
         "command": "node",
         "args": ["/path/to/mcp-server/dist/index.js"],
         "env": {
           "IDEA_BRIDGE_URL": "http://127.0.0.1:3100"
         }
       },
       "project-b-context": {
         "command": "node",
         "args": ["/path/to/mcp-server/dist/index.js"],
         "env": {
           "IDEA_BRIDGE_URL": "http://127.0.0.1:3101"
         }
       }
     }
   }
   ```

2. **Option B: Single Milvus with multiple collections**
   ```json
   {
     "env": {
       "MILVUS_COLLECTION": "project_a_symbols"
     }
   }
   ```

## Security Notes

- **Local development**: Default config assumes all services on localhost
- **Production**: Use authentication for Milvus (`MILVUS_USERNAME`/`MILVUS_PASSWORD`)
- **API keys**: Never commit `OPENAI_API_KEY` or other secrets to git
- **Firewall**: Bridge server should NOT be exposed to internet without authentication

## Next Steps

After successful configuration:

1. Test with simple query: "Find Spring @Service classes"
2. Verify module-level filtering works: "Search for UserService in auth-service module"
3. Check context budgeting: Large queries should return summarized results
4. Monitor performance: Search should complete in <200ms

For development workflows, see `AGENTS_CONTRIBUTING.md`.

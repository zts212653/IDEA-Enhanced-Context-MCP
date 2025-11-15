# MCP gRPC Connectivity & Search Harness Notes

Local Milvus access goes over an unsecured gRPC port (`127.0.0.1:19530`). When shell
sessions inherit corporate HTTP/HTTPS/all-proxy settings, Node/Python libraries will
try to send gRPC traffic through the proxy first and the connection gets dropped
before reaching Docker. Symptoms:

- `Error: 14 UNAVAILABLE: Connection dropped (retried …)` from `@grpc/grpc-js`
- `pymilvus.exceptions.MilvusException: Fail connecting to server on 127.0.0.1:19530`

## Fix: clear proxy env for the command

Before running the MCP harness (or any Milvus health check), clear proxy variables
in the shell session:

```bash
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
export NO_PROXY="localhost,127.0.0.1,.local,*.local,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
```

You can also inline them when running commands (see below).

## MCP search harness recipe

From the repo root:

```bash
cd mcp-server
source ../.venv/bin/activate

ALL_PROXY= HTTP_PROXY= HTTPS_PROXY= \
  DISABLE_SCHEMA_CHECK=1 \
  PREFERRED_LEVELS=module,class,method \
  MAX_CONTEXT_TOKENS=9000 \
  npm run tool:search -- "Which services depend on the discovery server?"
```

For the “show me all Spring beans” stress test (Q5) drop `MAX_CONTEXT_TOKENS` to 4000
so context budgeting and truncation thresholds kick in:

```bash
ALL_PROXY= HTTP_PROXY= HTTPS_PROXY= \
  DISABLE_SCHEMA_CHECK=1 \
  PREFERRED_LEVELS=module,class,method \
  MAX_CONTEXT_TOKENS=4000 \
  npm run tool:search -- "Show me all Spring beans in the entire project"
```

### Why `DISABLE_SCHEMA_CHECK=1`?

Sandboxed environments sometimes block Node’s gRPC `ensureCollectionExists` call even
after proxies are cleared. Setting `DISABLE_SCHEMA_CHECK=1` tells the Milvus client to
skip that `ensureCollectionExists` step and rely on the already-ingested schema. On a
fully open local setup you can omit the flag to keep auto-healing enabled.

### Expected outputs

- The command writes the structured MCP response to stdout (and you can `tee` it to
  `/tmp/mcp-q?.json` for inspection).
- `contextBudget` should report non-zero `usedTokens` and `deliveredResults` should
  match the scenario being tested (e.g., discovery clients/servers for the query above).

If you still see 14/UNAVAILABLE errors after clearing proxies, re-check that the local
Milvus Docker stack is up:

```bash
docker compose -f .idea-enhanced-context/milvus/docker-compose.yml --project-name idea-enhanced-context ps
```

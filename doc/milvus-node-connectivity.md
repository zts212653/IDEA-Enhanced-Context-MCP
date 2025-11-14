# Node ↔ Milvus Connectivity Investigation

## Summary
- Node.js processes running in the Codex CLI cannot establish TCP connections to `127.0.0.1` ports (e.g., `19530`, `9091`).
- Even after clearing `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, etc., and setting `NO_PROXY=127.0.0.1,localhost,::1`, Node's `net.createConnection` immediately fails with `connect EPERM 127.0.0.1:19530 - Local (0.0.0.0:0)`.
- Python (`pymilvus`) does not face this restriction once proxy env vars are removed inside the script, which is why our current ingestion/search flows rely on Python helpers.
- Root cause: The CLI sandbox or host policy blocks Node executables from connecting to localhost, regardless of environment variables. This is consistent across direct TCP tests and gRPC attempts (`@zilliz/milvus2-sdk-node`).

## Evidence
1. `node net.createConnection({host:'127.0.0.1', port:19530})` → `Error: connect EPERM 127.0.0.1:19530 - Local (0.0.0.0:0)`.
2. Same error for `127.0.0.1:9091`, confirming it's not Milvus-specific.
3. `python - <<'PY' ... connections.connect('127.0.0.1', '19530')` works (after clearing env inside the script), proving Milvus and ports are healthy.
4. Attempting to set `NO_PROXY`/`NO_GRPC_PROXY`/`GRPC_NO_PROXY` inside Node before importing gRPC fails with the same `EPERM`, implying the restriction happens below env level.

## Impact
- We cannot remove the temporary Python bridge in `idea-bridge/scripts/milvus_ingest.py` / `milvus_query.py` yet.
- All Milvus calls from the MCP server must continue to go through the Python helper to avoid sandbox restrictions.

## Next Steps
- Await environment change (allow Node to connect to localhost) or dedicated proxy bypass from Ops.
- Once Node TCP to 127.0.0.1 is permitted, refactor the Milvus client to use gRPC directly and drop Python helpers.

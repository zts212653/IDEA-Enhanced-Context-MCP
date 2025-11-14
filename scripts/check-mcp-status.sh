#!/bin/bash
set -euo pipefail

BRIDGE_URL=${IDEA_BRIDGE_URL:-${IDEA_BRIDGE_BASE_URL:-${IDEA_BRIDGE_HTTP:-http://127.0.0.1:63000}}}
MILVUS_ADDRESS=${MILVUS_ADDRESS:-127.0.0.1:19530}

echo "IDEA-Enhanced-Context MCP Status Check"
echo "Bridge URL : $BRIDGE_URL"
echo "Milvus Addr : $MILVUS_ADDRESS"

echo "--- Bridge /healthz ---"
curl -fsS "$BRIDGE_URL/healthz" || echo "Bridge health check failed"

echo "--- Bridge /api/info ---"
curl -fsS "$BRIDGE_URL/api/info" || echo "Bridge info unavailable"

echo "--- Milvus TCP Check ---"
python3 - <<PY
import socket, sys
addr = "${MILVUS_ADDRESS}"
host, _, port = addr.partition(":")
port = int(port or 19530)
s = socket.socket()
s.settimeout(2)
try:
    s.connect((host, port))
except Exception as exc:
    print(f"Milvus connection failed: {exc}")
    sys.exit(1)
else:
    print("Milvus reachable")
finally:
    s.close()
PY

echo "See doc/mcp-configuration-guide.md for details"

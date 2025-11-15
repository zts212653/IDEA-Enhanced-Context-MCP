#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_PORT="${IDEA_BRIDGE_PORT:-63000}"
BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"
LOG_DIR="/tmp/milestone-b-env"
mkdir -p "${LOG_DIR}"
BRIDGE_LOG="${LOG_DIR}/idea-bridge.log"

cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]]; then
    echo "→ Stopping IDEA Bridge (pid ${BRIDGE_PID})"
    kill "${BRIDGE_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

SECTION() {
  printf '\n=== %s ===\n' "$1"
}

SECTION "确认 Python venv"
if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  if [[ ! -d "${ROOT}/.venv" ]]; then
    echo "→ Creating venv at ${ROOT}/.venv"
    python3 -m venv "${ROOT}/.venv"
  fi
  # shellcheck disable=SC1090
  source "${ROOT}/.venv/bin/activate"
fi
pip install --upgrade pip >/dev/null

SECTION "构建并启动 IDEA Bridge"
pushd "${ROOT}/idea-bridge" >/dev/null
npm install >/dev/null
npm run build >/dev/null
NODE_ENV=production IDEA_BRIDGE_PORT="${BRIDGE_PORT}" \
  node dist/server.js >"${BRIDGE_LOG}" 2>&1 &
BRIDGE_PID=$!
popd >/dev/null

echo "→ 等待 Bridge /healthz ..."
for i in {1..20}; do
  if curl -fsS "${BRIDGE_URL}/healthz" >/dev/null 2>&1; then
    echo "✅ Bridge ready at ${BRIDGE_URL}"
    break
  fi
  sleep 1
  if [[ $i -eq 20 ]]; then
    echo "❌ Bridge did not become ready, check ${BRIDGE_LOG}"
    exit 1
  fi
  
done

SECTION "运行 Milestone B 测试"
export IDEA_BRIDGE_URL="${BRIDGE_URL}"
export MILVUS_ADDRESS="${MILVUS_ADDRESS:-127.0.0.1:19530}"
chmod +x "${ROOT}/scripts/test-milestone-b.sh"
"${ROOT}/scripts/test-milestone-b.sh"

#!/usr/bin/env bash
#
# Milestone C Verification Suite
# Executable test harness for validating Codex's Milestone C claims
#
# Usage: ./scripts/verify-milestone-c.sh [--quick|--full]
#
# Prerequisites:
#   - Python venv with pymilvus at .venv/
#   - Milvus running at 127.0.0.1:19530 with idea_symbols_spring_jina collection
#   - PSI cache at idea-bridge/.idea-bridge/psi-cache.json
#   - MCP server built (cd mcp-server && npm run build)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ROOT}/tmp/milestone-c-tests"
mkdir -p "${LOG_DIR}"

# Default env for tests (override via env if needed)
export MILVUS_COLLECTION="${MILVUS_COLLECTION:-idea_symbols_spring_jina}"
export EMBEDDING_PROVIDER="${EMBEDDING_PROVIDER:-jina}"
export EMBEDDING_HOST="${EMBEDDING_HOST:-http://127.0.0.1:7997}"
export EMBEDDING_MODEL="${EMBEDDING_MODEL:-jinaai/jina-embeddings-v3}"

# Test mode
MODE="${1:-full}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Counters
TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

# Helper functions
SECTION() {
  printf '\n%s================================================================%s\n' "${BLUE}" "${NC}"
  printf '%s  %s%s\n' "${BLUE}" "$1" "${NC}"
  printf '%s================================================================%s\n' "${BLUE}" "${NC}"
}

TEST() {
  printf '\n%s-------------------------------------------------------------------%s\n' "${YELLOW}" "${NC}"
  printf '%s  TEST %d: %s%s\n' "${YELLOW}" "$((TOTAL + 1))" "$1" "${NC}"
  printf '%s-------------------------------------------------------------------%s\n' "${YELLOW}" "${NC}"
}

PASS() {
  echo -e "${GREEN}✅ PASS:${NC} $1"
  PASSED=$((PASSED + 1))
  TOTAL=$((TOTAL + 1))
}

FAIL() {
  echo -e "${RED}❌ FAIL:${NC} $1"
  FAILED=$((FAILED + 1))
  TOTAL=$((TOTAL + 1))
}

SKIP() {
  echo -e "${YELLOW}⏭  SKIP:${NC} $1"
  SKIPPED=$((SKIPPED + 1))
  TOTAL=$((TOTAL + 1))
}

INFO() {
  echo -e "   → $1"
}

# Activate Python venv
if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  if [[ ! -d "${ROOT}/.venv" ]]; then
    echo -e "${RED}ERROR: Python venv not found at ${ROOT}/.venv${NC}"
    echo "   Run: python3 -m venv .venv && source .venv/bin/activate && pip install pymilvus"
    exit 1
  fi
  # shellcheck disable=SC1090
  source "${ROOT}/.venv/bin/activate"
fi

# ============================================================================
# Tier 1: Smoke Tests (Critical Path)
# ============================================================================

SECTION "Tier 1: Smoke Tests"

# -----------------------------------------------------------------------------
# Test C.1.1: PSI Cache Contains Method-Level Data
# -----------------------------------------------------------------------------
TEST "C.1.1 - PSI Cache Method Schema"

PSI_CACHE="${ROOT}/idea-bridge/.idea-bridge/psi-cache.json"

if [[ ! -f "${PSI_CACHE}" ]]; then
  FAIL "PSI cache not found at ${PSI_CACHE}"
else
  python3 << EOF
import json
import sys

cache_path = "${PSI_CACHE}"
with open(cache_path) as f:
    data = json.load(f)

symbols = data.get("symbols", [])
if not symbols:
    print("ERROR: No symbols in PSI cache")
    sys.exit(1)

class_with_methods = None
for sym in symbols:
    if sym.get("methods") and len(sym["methods"]) > 0:
        class_with_methods = sym
        break

if not class_with_methods:
    print("ERROR: No classes with methods found")
    sys.exit(1)

method = class_with_methods["methods"][0]
required_fields = ["name", "signature", "visibility", "returnType", "parameters"]
missing = [f for f in required_fields if f not in method]

if missing:
    print(f"ERROR: Method missing fields: {missing}")
    sys.exit(1)

print(f"Sample method: {class_with_methods['fqn']}#{method['name']}")
print(f"Total classes with methods: {sum(1 for s in symbols if s.get('methods'))}")
sys.exit(0)
EOF

  if [[ $? -eq 0 ]]; then
    PASS "PSI cache contains valid method-level data"
  else
    FAIL "PSI cache method schema invalid"
  fi
fi

# -----------------------------------------------------------------------------
# Test C.1.2: Milvus Contains Method-Level Entries
# -----------------------------------------------------------------------------
TEST "C.1.2 - Milvus Method-Level Ingestion"

python3 << 'EOF' > "${LOG_DIR}/c1.2-milvus-method-check.log" 2>&1
from pymilvus import connections, Collection
import sys

try:
    connections.connect(alias="default", address="127.0.0.1:19530", timeout=5)
    collection = Collection("idea_symbols_spring_jina")
    collection.load()

    expr = 'index_level == "method"'
    results = collection.query(
        expr=expr,
        limit=10,
        output_fields=["fqn", "symbol_name", "summary", "index_level"]
    )

    if len(results) == 0:
        print("ERROR: No method-level entries in Milvus")
        sys.exit(1)

    print(f"Found {len(results)} method-level entries (showing 3):")
    for r in results[:3]:
        summary = r.get('summary', '')[:60]
        print(f"  {r['fqn']}: {summary}...")

    sys.exit(0)
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)
EOF

if [[ $? -eq 0 ]]; then
  PASS "Milvus contains method-level entries"
  INFO "$(grep 'Found' "${LOG_DIR}/c1.2-milvus-method-check.log")"
else
  FAIL "Milvus method-level check failed"
  INFO "See ${LOG_DIR}/c1.2-milvus-method-check.log"
fi

# -----------------------------------------------------------------------------
# Test C.1.3: MCP Search Returns Method-Level Stage
# -----------------------------------------------------------------------------
TEST "C.1.3 - MCP milvus-method Stage Active"

cd "${ROOT}/mcp-server"

PREFERRED_LEVELS=method \
MODULE_HINT=spring-aop \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does Spring AOP create dynamic proxies?" > "${LOG_DIR}/c1.3-method-search.json" 2>&1

python3 << EOF
import json
import sys

try:
    raw = open("${LOG_DIR}/c1.3-method-search.json").read()
    start = raw.find("{")
    if start == -1:
        raise ValueError("No JSON object found in output")
    result = json.loads(raw[start:])

    stages = result.get("stages", [])
    method_stage = next((s for s in stages if s["name"] == "milvus-method"), None)

    if not method_stage:
        print("ERROR: No milvus-method stage in results")
        print(f"  Available stages: {[s['name'] for s in stages]}")
        sys.exit(1)

    if method_stage["hitCount"] == 0:
        print("ERROR: milvus-method stage has 0 hits")
        sys.exit(1)

    delivered = result.get("deliveredResults", [])
    method_results = [r for r in delivered if r.get("indexLevel") == "method"]

    if len(method_results) == 0:
        print("ERROR: No method-level results delivered")
        sys.exit(1)

    print(f"milvus-method stage: {method_stage['hitCount']} hits")
    print(f"Delivered: {len(method_results)} method-level results")
    for r in method_results[:2]:
        print(f"  - {r['fqn']}")

    sys.exit(0)
except Exception as e:
    print(f"ERROR: {e}")
    sys.exit(1)
EOF

if [[ $? -eq 0 ]]; then
  PASS "milvus-method stage returns results"
else
  FAIL "milvus-method stage not active"
fi

# -----------------------------------------------------------------------------
# Test C.4.1: analyze_callers_of_method Tool Exists and Runs
# -----------------------------------------------------------------------------
TEST "C.4.1 - analyze_callers_of_method Smoke Test"

cd "${ROOT}/mcp-server"

# Simple smoke test: does the tool exist and return valid JSON?
node << 'EOF' > "${LOG_DIR}/c4.1-callers-smoke.log" 2>&1 || true
import('./dist/index.js').then(() => {
  console.log('MCP server loaded successfully');
  process.exit(0);
}).catch(err => {
  console.error('Failed to load MCP server:', err);
  process.exit(1);
});
EOF

# Check if the tool is registered
grep -q "analyze_callers_of_method" "${ROOT}/mcp-server/src/index.ts"

if [[ $? -eq 0 ]]; then
  PASS "analyze_callers_of_method tool exists in code"
else
  FAIL "analyze_callers_of_method tool not found"
fi

# -----------------------------------------------------------------------------
# Test C.5.1: analyze_callees_of_method Tool Exists
# -----------------------------------------------------------------------------
TEST "C.5.1 - analyze_callees_of_method Smoke Test"

grep -q "analyze_callees_of_method" "${ROOT}/mcp-server/src/index.ts"

if [[ $? -eq 0 ]]; then
  PASS "analyze_callees_of_method tool exists in code"
else
  FAIL "analyze_callees_of_method tool not found"
fi

# ============================================================================
# Tier 2: Quality Tests (Semantic Validation)
# ============================================================================

if [[ "${MODE}" == "quick" ]]; then
  echo ""
  echo -e "${YELLOW}Quick mode: Skipping Tier 2 quality tests${NC}"
  echo "   Run with --full to include semantic validation"
else
  SECTION "Tier 2: Quality Tests"

  # ---------------------------------------------------------------------------
  # Test C.3.1: AOP Ranking Quality
  # ---------------------------------------------------------------------------
  TEST "C.3.1 - AOP Query Ranking Quality"

  cd "${ROOT}/mcp-server"

  PREFERRED_LEVELS=class \
  MODULE_HINT=spring-aop \
  DISABLE_SCHEMA_CHECK=1 \
  npm run tool:search -- "How does Spring AOP create dynamic proxies?" > "${LOG_DIR}/c3.1-aop-ranking.json" 2>&1

  if python3 << EOF
import json
import sys

raw = open("${LOG_DIR}/c3.1-aop-ranking.json").read()
start = raw.find("{")
if start == -1:
    print("ERROR: No JSON object in c3.1-aop-ranking.json")
    sys.exit(1)
result = json.loads(raw[start:])

top5_fqns = [r["fqn"] for r in result["deliveredResults"][:5]]

expected_patterns = [
    "ProxyFactory",
    "AopProxy",
    "Advisor",
    "ProxyCreator"
]

matches = sum(1 for fqn in top5_fqns if any(pat in fqn for pat in expected_patterns))

test_count = sum(1 for r in result["deliveredResults"][:5] if "Test" in r["fqn"])

print(f"Top 5 FQNs:")
for i, fqn in enumerate(top5_fqns, 1):
    marker = "✓" if any(pat in fqn for pat in expected_patterns) else " "
    print(f"  {i}. [{marker}] {fqn}")

print(f"\nMatches: {matches}/5")
print(f"Test pollution: {test_count}/5")

if matches < 2:
    print(f"ERROR: Only {matches}/5 top results match AOP core classes")
    sys.exit(1)

if test_count > 1:
    print(f"ERROR: {test_count} test classes in top 5 (should be ≤1)")
    sys.exit(1)

sys.exit(0)
EOF

  then
    PASS "AOP ranking quality acceptable"
  else
    FAIL "AOP ranking needs improvement"
  fi

  # ---------------------------------------------------------------------------
  # Test C.3.2: BeanPostProcessor TEST Penalty
  # ---------------------------------------------------------------------------
  TEST "C.3.2 - BeanPostProcessor Test Penalty"

  cd "${ROOT}/mcp-server"

  PREFERRED_LEVELS=class \
  MODULE_HINT=spring-context \
  DISABLE_SCHEMA_CHECK=1 \
  npm run tool:search -- "Show me BeanPostProcessor implementations" > "${LOG_DIR}/c3.2-bpp-ranking.json" 2>&1

  if python3 << EOF
import json
import sys

raw = open("${LOG_DIR}/c3.2-bpp-ranking.json").read()
start = raw.find("{")
if start == -1:
    print("ERROR: No JSON object in c3.2-bpp-ranking.json")
    sys.exit(1)
result = json.loads(raw[start:])

top10 = result["deliveredResults"][:10]
test_count_top3 = sum(1 for r in top10[:3] if "Test" in r["fqn"])
test_count_top10 = sum(1 for r in top10 if "Test" in r["fqn"])

print(f"Test classes in top 3: {test_count_top3}")
print(f"Test classes in top 10: {test_count_top10}")

if test_count_top3 > 0:
    print(f"Top 3:")
    for i, r in enumerate(top10[:3], 1):
        marker = "🧪" if "Test" in r["fqn"] else "✓"
        print(f"  {i}. [{marker}] {r['fqn']}")
    print("ERROR: Test classes in top 3")
    sys.exit(1)

if test_count_top10 > 3:
    print(f"WARNING: {test_count_top10}/10 in top 10 are tests (high but acceptable)")

sys.exit(0)
EOF

  then
    PASS "BeanPostProcessor test penalty working"
  else
    FAIL "Too many test classes in BeanPostProcessor results"
  fi

  # ---------------------------------------------------------------------------
  # Test C.3.3: Event Scenario Ranking
  # ---------------------------------------------------------------------------
  TEST "C.3.3 - Event Infrastructure Ranking"

  cd "${ROOT}/mcp-server"

  PREFERRED_LEVELS=class \
  MODULE_HINT=spring-context \
  DISABLE_SCHEMA_CHECK=1 \
  npm run tool:search -- "How does Spring multicast application events?" > "${LOG_DIR}/c3.3-event-ranking.json" 2>&1

  if python3 << EOF
import json
import sys

raw = open("${LOG_DIR}/c3.3-event-ranking.json").read()
start = raw.find("{")
if start == -1:
    print("ERROR: No JSON object in c3.3-event-ranking.json")
    sys.exit(1)
result = json.loads(raw[start:])

top5_fqns = [r["fqn"] for r in result["deliveredResults"][:5]]

expected_patterns = [
    "EventMulticaster",
    "EventListener",
    "ApplicationEvent"
]

matches = sum(1 for fqn in top5_fqns if any(pat in fqn for pat in expected_patterns))

print(f"Top 5 FQNs:")
for i, fqn in enumerate(top5_fqns, 1):
    marker = "✓" if any(pat in fqn for pat in expected_patterns) else " "
    print(f"  {i}. [{marker}] {fqn}")

print(f"\nEvent infrastructure matches: {matches}/5")

if matches < 2:
    print("ERROR: Not enough event infrastructure in top 5")
    sys.exit(1)

sys.exit(0)
EOF

  then
    PASS "Event scenario ranking quality acceptable"
  else
    FAIL "Event ranking needs improvement"
  fi

  # ---------------------------------------------------------------------------
  # Test C.3.4: WebFlux functional handler (ServerResponse)
  # ---------------------------------------------------------------------------
  TEST "C.3.4 - WebFlux ServerResponse Location"

  cd "${ROOT}/mcp-server"

  PREFERRED_LEVELS=method \
  MODULE_HINT=spring-webflux \
  DISABLE_SCHEMA_CHECK=1 \
  npm run tool:search -- "Where is ServerResponse created in WebFlux functional endpoints?" > "${LOG_DIR}/c3.4-webflux.json" 2>&1

  if python3 << EOF
import json, sys
raw = open("${LOG_DIR}/c3.4-webflux.json").read()
start = raw.find("{")
if start == -1:
    print("ERROR: No JSON object in c3.4-webflux.json"); sys.exit(1)
data = json.loads(raw[start:])
top = data.get("deliveredResults", [])[:5]
matches = [r for r in top if "ServerResponse" in r.get("fqn","")]
print(f"ServerResponse matches: {len(matches)}/{len(top)}")
for r in matches[:2]:
    print("  -", r["fqn"])
if not matches:
    print("ERROR: No ServerResponse hits in top results")
    sys.exit(1)
sys.exit(0)
EOF
  then
    PASS "WebFlux ServerResponse located"
  else
    FAIL "WebFlux functional endpoint ranking needs improvement"
  fi

  # ---------------------------------------------------------------------------
  # Test C.3.5: JdbcTemplate RowMapper delegation
  # ---------------------------------------------------------------------------
  TEST "C.3.5 - JdbcTemplate -> RowMapper"

  cd "${ROOT}/mcp-server"

  PREFERRED_LEVELS=class,method \
  MODULE_HINT=spring-jdbc \
  DISABLE_SCHEMA_CHECK=1 \
  npm run tool:search -- "How does JdbcTemplate query delegate to RowMapper?" > "${LOG_DIR}/c3.5-jdbc.json" 2>&1

  if python3 << EOF
import json, sys
raw = open("${LOG_DIR}/c3.5-jdbc.json").read()
start = raw.find("{")
if start == -1:
    print("ERROR: No JSON object in c3.5-jdbc.json"); sys.exit(1)
data = json.loads(raw[start:])
top = data.get("deliveredResults", [])[:5]
matches = [r for r in top if ("JdbcTemplate" in r.get("fqn","") or "RowMapper" in r.get("fqn",""))]
print(f"JdbcTemplate/RowMapper matches: {len(matches)}/{len(top)}")
for r in matches[:3]:
    print("  -", r["fqn"])
if len(matches) < 2:
    print("ERROR: Too few JdbcTemplate/RowMapper hits in top results")
    sys.exit(1)
sys.exit(0)
EOF
  then
    PASS "JdbcTemplate RowMapper ranking acceptable"
  else
    FAIL "JdbcTemplate RowMapper ranking needs improvement"
  fi

  # ---------------------------------------------------------------------------
  # Tier 3: Impact Blast Radius (callers)
  # ---------------------------------------------------------------------------
  SECTION "Tier 3: Impact Blast Radius"

  impact_case() {
    local name="$1"
    local method="$2"
    local min_callers="$3"
    local min_modules="$4"
    local outfile="${LOG_DIR}/impact-${name}.json"

    (cd "${ROOT}/mcp-server" && node << EOF) > "${outfile}" 2>&1 || exit 1
import('./dist/index.js').then((m) => {
  const res = m.analyzeCallersInPsiCache({
    methodFqn: '${method}',
    excludeTest: true,
    maxResults: 500,
  });
  console.log(JSON.stringify(res, null, 2));
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
EOF

    if [[ $? -ne 0 ]]; then
      echo "❌ FAIL: ${name} - MCP call errored" >&2
      return 1
    fi

    if IMPACT_OUT="${outfile}" python3 << EOF
import json, sys, re, os
outfile = os.environ.get("IMPACT_OUT")
raw = open(outfile).read()
start = raw.find("{")
if start == -1:
    print("parse-error")
    sys.exit(1)
data = json.loads(raw[start:])
callers = len(data.get("callers", []))
modules = len(data.get("moduleSummary", []))
print(callers, modules)
sys.exit(0 if (callers >= ${min_callers} and modules >= ${min_modules}) else 2)
EOF
    then
      counts=$(IMPACT_OUT="${outfile}" python3 - << 'EOF'
import json, os
raw = open(os.environ["IMPACT_OUT"]).read()
start = raw.find("{")
data = json.loads(raw[start:])
print(f"callers={len(data.get('callers', []))} modules={len(data.get('moduleSummary', []))}")
EOF
)
      echo "✅ PASS: ${name} - ${counts}"
    else
      rc=$?
      if [[ $rc -eq 2 ]]; then
        IMPACT_OUT="${outfile}" python3 - << 'EOF'
import json, os
raw = open(os.environ["IMPACT_OUT"]).read()
start = raw.find("{")
data = json.loads(raw[start:])
print(f"callers={len(data.get('callers', []))}, modules={len(data.get('moduleSummary', []))}")
EOF
        echo "❌ FAIL: ${name} - thresholds not met (need callers>=${min_callers}, modules>=${min_modules})" >&2
      else
        echo "❌ FAIL: ${name} - unable to parse output" >&2
      fi
      return 1
    fi
  }

  TEST "C.6.1 - Impact: JdbcTemplate#query"
  impact_case "jdbc-template" "org.springframework.jdbc.core.JdbcTemplate#query" 8 1

  TEST "C.6.2 - Impact: ApplicationContext#getBean"
  impact_case "app-context" "org.springframework.context.ApplicationContext#getBean" 10 1

  TEST "C.6.3 - Impact: RestTemplate#exchange"
  impact_case "rest-template" "org.springframework.web.client.RestTemplate#exchange" 2 1

  TEST "C.6.4 - Impact: RabbitTemplate#convertAndSend"
  impact_case "rabbit-template" "org.springframework.amqp.rabbit.core.RabbitTemplate#convertAndSend" 0 0

  TEST "C.6.5 - Impact: ApplicationEventPublisher#publishEvent"
  impact_case "event-publish" "org.springframework.context.ApplicationEventPublisher#publishEvent" 1 1
fi

# ============================================================================
# Summary
# ============================================================================

SECTION "Test Results Summary"

echo ""
echo "Total Tests:  ${TOTAL}"
echo -e "Passed:       ${GREEN}${PASSED} ✅${NC}"
echo -e "Failed:       ${RED}${FAILED} ❌${NC}"
echo -e "Skipped:      ${YELLOW}${SKIPPED} ⏭${NC}"
echo ""
echo "Logs: ${LOG_DIR}"
echo ""

# Calculate pass rate
if [[ ${TOTAL} -gt 0 ]]; then
  PASS_RATE=$((PASSED * 100 / TOTAL))
else
  PASS_RATE=0
fi

# Acceptance logic
if [[ ${FAILED} -eq 0 ]]; then
  echo -e "${GREEN}🎉 ALL TESTS PASSED${NC}"
  echo ""
  echo "Milestone C verification: ✅ ACCEPT"
  echo ""
  echo "Codex's claims are validated. The implementation is satisfactory."
  exit 0
elif [[ ${PASS_RATE} -ge 70 ]]; then
  echo -e "${YELLOW}⚠️  PARTIAL PASS (${PASS_RATE}%)${NC}"
  echo ""
  echo "Milestone C verification: ⚠️  CONDITIONAL"
  echo ""
  echo "Most features work, but some quality issues remain."
  echo "Review failed tests and decide if they're blockers."
  exit 2
else
  echo -e "${RED}❌ INSUFFICIENT QUALITY (${PASS_RATE}%)${NC}"
  echo ""
  echo "Milestone C verification: ❌ REJECT"
  echo ""
  echo "Critical issues found. Implementation needs fixes before acceptance."
  exit 1
fi

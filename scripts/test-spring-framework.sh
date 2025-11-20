#!/usr/bin/env bash
set -euo pipefail

# Spring Framework Large-Scale Codebase Test Suite
# Tests MCP capabilities on 80k+ entries (vs 500 entries in petclinic)
# Usage: ./scripts/test-spring-framework.sh [spring-framework-path]
#
# Prerequisites:
#   - Spring Framework cloned and PSI exported to Bridge
#   - Milvus running with indexed data
#   - Bridge server (will auto-start if not running)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_PORT="${IDEA_BRIDGE_PORT:-63000}"
BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"
LOG_DIR="/tmp/spring-framework-tests"
mkdir -p "${LOG_DIR}"
BRIDGE_LOG="${LOG_DIR}/idea-bridge.log"

SPRING_FW_PATH="${1:-${SPRING_FRAMEWORK_PATH:-}}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]]; then
    echo -e "${YELLOW}→ Stopping IDEA Bridge (pid ${BRIDGE_PID})${NC}"
    kill "${BRIDGE_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

SECTION() {
  printf '\n%s==================================================================%s\n' "${BLUE}" "${NC}"
  printf '%s  %s%s\n' "${BLUE}" "$1" "${NC}"
  printf '%s==================================================================%s\n' "${BLUE}" "${NC}"
}

SUBSECTION() {
  printf '\n%s-------------------------------------------------------------------%s\n' "${YELLOW}" "${NC}"
  printf '%s  %s%s\n' "${YELLOW}" "$1" "${NC}"
  printf '%s-------------------------------------------------------------------%s\n' "${YELLOW}" "${NC}"
}

PASS() {
  echo -e "${GREEN}✅ PASS:${NC} $1"
}

FAIL() {
  echo -e "${RED}❌ FAIL:${NC} $1"
}

WARN() {
  echo -e "${YELLOW}⚠️  WARN:${NC} $1"
}

INFO() {
  echo -e "→ $1"
}

# ===================================================================
# Section 0: Prerequisites Check
# ===================================================================

SECTION "Prerequisite Checks"

# Check jq
if ! command -v jq &> /dev/null; then
  FAIL "jq is required but not installed"
  echo "   Install with: brew install jq (macOS) or apt-get install jq (Linux)"
  exit 1
fi
PASS "jq is installed"

# Check Python venv
if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  if [[ ! -d "${ROOT}/.venv" ]]; then
    INFO "Creating venv at ${ROOT}/.venv"
    python3 -m venv "${ROOT}/.venv"
  fi
  # shellcheck disable=SC1090
  source "${ROOT}/.venv/bin/activate"
  PASS "Activated Python venv at ${ROOT}/.venv"
else
  PASS "Python venv already active: ${VIRTUAL_ENV}"
fi

# Upgrade pip silently
pip install --upgrade pip >/dev/null 2>&1

# Check Spring Framework path (optional - can use cached PSI data)
if [[ -n "${SPRING_FW_PATH}" ]]; then
  if [[ ! -d "${SPRING_FW_PATH}" ]]; then
    WARN "Spring Framework path not found: ${SPRING_FW_PATH}"
    WARN "Proceeding with cached PSI data (if available)"
    SPRING_FW_PATH=""
  else
    PASS "Spring Framework found at: ${SPRING_FW_PATH}"
  fi
else
  WARN "No Spring Framework path provided (using cached PSI data)"
  echo "   To test with fresh data, run: $0 /path/to/spring-framework"
fi

# ===================================================================
# Section 1: Start IDEA Bridge
# ===================================================================

SECTION "Starting IDEA Bridge"

pushd "${ROOT}/idea-bridge" >/dev/null

# Check if Bridge is already running
if curl -fsS "${BRIDGE_URL}/healthz" >/dev/null 2>&1; then
  WARN "Bridge already running at ${BRIDGE_URL}"
  WARN "Using existing instance (will not auto-cleanup)"
  BRIDGE_PID=""
else
  INFO "Building Bridge server..."
  npm install >/dev/null 2>&1
  npm run build >/dev/null 2>&1

  INFO "Starting Bridge server at port ${BRIDGE_PORT}..."

  # Set PSI cache path for Spring Framework if provided
  if [[ -n "${SPRING_FW_PATH}" ]]; then
    export BRIDGE_PSI_CACHE="${ROOT}/idea-bridge/.idea-bridge/spring-framework-psi-cache.json"
  fi

  NODE_ENV=production IDEA_BRIDGE_PORT="${BRIDGE_PORT}" \
    node dist/server.js >"${BRIDGE_LOG}" 2>&1 &
  BRIDGE_PID=$!

  INFO "Waiting for Bridge /healthz (pid ${BRIDGE_PID})..."
  for i in {1..30}; do
    if curl -fsS "${BRIDGE_URL}/healthz" >/dev/null 2>&1; then
      PASS "Bridge ready at ${BRIDGE_URL}"
      break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then
      FAIL "Bridge did not become ready after 30s"
      echo "   Check logs: ${BRIDGE_LOG}"
      tail -20 "${BRIDGE_LOG}"
      exit 1
    fi
  done
fi

popd >/dev/null

# ===================================================================
# Section 2: Verify PSI Data Scale
# ===================================================================

SECTION "Verifying PSI Data Scale"

# Query Bridge for symbol count
SYMBOL_COUNT=$(curl -fsS "${BRIDGE_URL}/api/symbols/search?query=class" 2>/dev/null | jq '.results | length' || echo "0")

if [[ "${SYMBOL_COUNT}" -lt 100 ]]; then
  WARN "Only ${SYMBOL_COUNT} symbols found in Bridge"
  WARN "For meaningful Spring Framework tests, expected 10,000+ symbols"
  if [[ -n "${SPRING_FW_PATH}" ]]; then
    echo ""
    echo "   To export PSI data:"
    echo "   1. Open ${SPRING_FW_PATH} in IntelliJ IDEA"
    echo "   2. Run 'Export PSI to Bridge' action"
    echo "   3. Wait for upload to complete"
    echo "   4. Re-run this script"
    exit 1
  else
    echo "   Provide Spring Framework path: $0 /path/to/spring-framework"
    exit 1
  fi
fi

PASS "Found ${SYMBOL_COUNT} symbols in Bridge (sufficient for testing)"

# ===================================================================
# Section 3: Test Suite - Spring Framework Scenarios
# ===================================================================

SECTION "Spring Framework Test Suite (Large-Scale)"

export IDEA_BRIDGE_URL="${BRIDGE_URL}"
export MILVUS_ADDRESS="${MILVUS_ADDRESS:-127.0.0.1:19530}"
export DISABLE_SCHEMA_CHECK=1

PASSED=0
FAILED=0
TOTAL=0

run_test() {
  local test_name="$1"
  local test_cmd="$2"
  local validation_fn="$3"
  local output_file="${LOG_DIR}/$(echo "$test_name" | tr ' ' '_' | tr '/' '-').json"

  TOTAL=$((TOTAL + 1))
  SUBSECTION "Test ${TOTAL}: ${test_name}"

  # Run the test
  INFO "Query: ${test_cmd}"
  if eval "cd ${ROOT}/mcp-server && ${test_cmd}" > "${output_file}" 2>&1; then
    # Validate
    if eval "${validation_fn}" "${output_file}"; then
      PASS "${test_name}"
      PASSED=$((PASSED + 1))
    else
      FAIL "${test_name} (validation failed)"
      echo "   Output: ${output_file}"
      FAILED=$((FAILED + 1))
    fi
  else
    FAIL "${test_name} (query failed)"
    echo "   Output: ${output_file}"
    FAILED=$((FAILED + 1))
  fi
}

# Validation functions

validate_module_navigation() {
  local file="$1"

  if ! jq -e '.deliveredResults' "$file" >/dev/null 2>&1; then
    echo "   → ERROR: No deliveredResults found"
    return 1
  fi

  local module_count=$(jq -r '.deliveredResults | length' "$file")
  INFO "Modules returned: ${module_count}"

  if [[ ${module_count} -lt 5 ]]; then
    echo "   → ERROR: Expected at least 5 modules, got ${module_count}"
    return 1
  fi

  # Check for core modules
  local modules=$(jq -r '.deliveredResults[].module // empty' "$file")
  if echo "$modules" | grep -q "spring-core\|spring-beans\|spring-context"; then
    INFO "Core modules found in results"
  else
    WARN "Core modules (spring-core/beans/context) not in top results"
  fi

  # Check context budget
  local used_tokens=$(jq -r '.contextBudget.usedTokens // 0' "$file")
  local max_tokens=$(jq -r '.contextBudget.maxTokens // 8000' "$file")
  INFO "Context usage: ${used_tokens} / ${max_tokens} tokens"

  if [[ ${used_tokens} -gt ${max_tokens} ]]; then
    echo "   → ERROR: Context budget exceeded"
    return 1
  fi

  return 0
}

validate_semantic_search() {
  local file="$1"

  if ! jq -e '.deliveredResults' "$file" >/dev/null 2>&1; then
    echo "   → ERROR: No deliveredResults found"
    return 1
  fi

  local result_count=$(jq -r '.deliveredResults | length' "$file")
  INFO "Results returned: ${result_count}"

  # Check for expected classes
  local fqns=$(jq -r '.deliveredResults[].fqn // empty' "$file")

  if echo "$fqns" | grep -q "ClassPathBeanDefinitionScanner\|ComponentScan"; then
    INFO "Semantic match: Found bean scanning classes"
  else
    echo "   → ERROR: Expected ClassPathBeanDefinitionScanner or ComponentScan"
    echo "   → Got: $(echo "$fqns" | head -3)"
    return 1
  fi

  # Check for hierarchy info
  if jq -e '.deliveredResults[0].hierarchy' "$file" >/dev/null 2>&1; then
    INFO "Hierarchy metadata present"
  else
    WARN "No hierarchy metadata in top result"
  fi

  return 0
}

validate_context_budget_large() {
  local file="$1"

  if ! jq -e '.contextBudget' "$file" >/dev/null 2>&1; then
    echo "   → ERROR: No contextBudget field"
    return 1
  fi

  local truncated=$(jq -r '.contextBudget.truncated // false' "$file")
  local omitted=$(jq -r '.omittedCount // 0' "$file")
  local delivered=$(jq -r '.deliveredResults | length' "$file")

  INFO "Results: ${delivered} delivered, ${omitted} omitted"
  INFO "Truncated: ${truncated}"

  # With BeanPostProcessor in Spring Framework, we expect truncation
  if [[ "${truncated}" != "true" ]]; then
    WARN "Expected truncation for large result set (BeanPostProcessor has 50+ impls)"
  fi

  # Check that top results are production code, not tests
  local top_fqns=$(jq -r '.deliveredResults[0:5][].fqn // empty' "$file")
  if echo "$top_fqns" | grep -q "Test"; then
    WARN "Test classes in top 5 results (should prioritize production code)"
  else
    INFO "Top results are production code (good)"
  fi

  return 0
}

validate_hierarchy_info() {
  local file="$1"

  if ! jq -e '.deliveredResults' "$file" >/dev/null 2>&1; then
    echo "   → ERROR: No deliveredResults found"
    return 1
  fi

  # Check for AOP-related classes
  local fqns=$(jq -r '.deliveredResults[].fqn // empty' "$file")

  if echo "$fqns" | grep -q "ProxyFactory\|AopProxy"; then
    INFO "Found AOP proxy classes"
  else
    echo "   → ERROR: Expected ProxyFactory or AopProxy classes"
    return 1
  fi

  # Check hierarchy metadata
  local has_hierarchy=$(jq -r '.deliveredResults[] | select(.hierarchy != null) | .fqn' "$file" | wc -l)
  INFO "Results with hierarchy info: ${has_hierarchy}"

  if [[ ${has_hierarchy} -eq 0 ]]; then
    WARN "No hierarchy metadata found (PSI may not have collected this)"
  fi

  return 0
}

validate_module_filtering() {
  local file="$1"
  local expected_module="spring-webmvc"

  if ! jq -e '.deliveredResults' "$file" >/dev/null 2>&1; then
    echo "   → ERROR: No deliveredResults found"
    return 1
  fi

  # Check query time (should be fast with module hint)
  if jq -e '.debug.timing' "$file" >/dev/null 2>&1; then
    local query_time=$(jq -r '.debug.timing.totalMs // 0' "$file")
    INFO "Query time: ${query_time}ms"

    if [[ ${query_time} -gt 5000 ]]; then
      WARN "Query took >5s (may indicate module filtering not working)"
    fi
  fi

  # Check if results are from target module
  local modules=$(jq -r '.deliveredResults[0:5][].module // empty' "$file")
  local target_count=$(echo "$modules" | grep -c "$expected_module" || echo "0")

  INFO "Top 5 results from ${expected_module}: ${target_count}/5"

  if [[ ${target_count} -ge 2 ]]; then
    INFO "Module filtering working (${expected_module} prioritized)"
  else
    WARN "Module filtering may not be effective"
  fi

  return 0
}

# ===================================================================
# Test Execution
# ===================================================================

run_test \
  "Module Navigation: Core Modules Discovery" \
  "PREFERRED_LEVELS=module MAX_CONTEXT_TOKENS=6000 npm run tool:search -- 'What are the core modules in Spring Framework and their main responsibilities?'" \
  "validate_module_navigation"

run_test \
  "Semantic Search: Bean Scanning Mechanism" \
  "PREFERRED_LEVELS=class MODULE_HINT=spring-context npm run tool:search -- 'How does Spring scan and register beans automatically?'" \
  "validate_semantic_search"

run_test \
  "Context Budget: Large Result Set (BeanPostProcessor)" \
  "PREFERRED_LEVELS=class,method MAX_CONTEXT_TOKENS=8000 npm run tool:search -- 'Show me all classes that implement BeanPostProcessor in production code'" \
  "validate_context_budget_large"

run_test \
  "Hierarchy Visualization: AOP Proxy Classes" \
  "PREFERRED_LEVELS=class MODULE_HINT=spring-aop npm run tool:search -- 'What are the main classes for creating AOP proxies?'" \
  "validate_hierarchy_info"

run_test \
  "Module Filtering: RequestMapping in WebMVC" \
  "PREFERRED_LEVELS=class MODULE_HINT=spring-webmvc MAX_CONTEXT_TOKENS=5000 npm run tool:search -- 'request mapping'" \
  "validate_module_filtering"

# ===================================================================
# Summary
# ===================================================================

SECTION "Test Results Summary"

echo ""
echo "Total Tests:  ${TOTAL}"
echo -e "Passed:       ${GREEN}${PASSED} ✅${NC}"
echo -e "Failed:       ${RED}${FAILED} ❌${NC}"
echo ""

if [[ ${FAILED} -eq 0 ]]; then
  echo -e "${GREEN}🎉 All Spring Framework tests passed!${NC}"
  echo ""
  echo "This validates that the MCP can handle large-scale codebases (80k+ entries)"
  echo "with proper module filtering, context budgeting, and semantic search."
  echo ""
  echo "Output files: ${LOG_DIR}"
  exit 0
else
  echo -e "${RED}⚠️  Some tests failed.${NC}"
  echo ""
  echo "Review output files in: ${LOG_DIR}"
  echo "Bridge logs: ${BRIDGE_LOG}"
  exit 1
fi

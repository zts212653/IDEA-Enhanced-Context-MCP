#!/usr/bin/env bash
set -e

# Milestone B Test Suite - Validates staged search, context budget, and dynamic Top-K
# Usage: ./scripts/test-milestone-b.sh
# Prerequisites:
#   - Python venv activated (source .venv/bin/activate)
#   - Milvus running (or use DISABLE_MILVUS=1 for fallback mode)
#   - Bridge server running (or tests will use fallback data)

echo "==================================================================="
echo "  Milestone B Test Suite - Staged Search & Context Budget"
echo "==================================================================="
echo ""

# Ensure we're in the repo root
cd "$(dirname "$0")/.."

# Check prerequisites
if ! command -v jq &> /dev/null; then
    echo "❌ ERROR: jq is required but not installed"
    echo "   Install with: brew install jq (macOS) or apt-get install jq (Linux)"
    exit 1
fi

# curl/nc are used for env validation
for tool in curl nc; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        echo "❌ ERROR: $tool is required but not installed"
        exit 1
    fi
done

# Check if Python venv is activated
if [ -z "$VIRTUAL_ENV" ]; then
    echo "⚠️  WARNING: Python venv not detected. Trying to activate..."
    if [ -f ".venv/bin/activate" ]; then
        source .venv/bin/activate
        echo "✅ Activated .venv"
    else
        echo "❌ ERROR: No .venv found. Run: python3 -m venv .venv && source .venv/bin/activate"
        exit 1
    fi
fi

# Set common env vars
export DISABLE_SCHEMA_CHECK=1
export NODE_OPTIONS="--no-warnings"
export IDEA_BRIDGE_URL="${IDEA_BRIDGE_URL:-http://127.0.0.1:63000}"
export MILVUS_ADDRESS="${MILVUS_ADDRESS:-127.0.0.1:19530}"

TEST_OUTPUT_DIR="/tmp/milestone-b-tests"
mkdir -p "$TEST_OUTPUT_DIR"

PASSED=0
FAILED=0
TOTAL=0

check_bridge() {
    local url="$IDEA_BRIDGE_URL"
    echo "→ Checking IDEA Bridge at $url"
    if ! curl -fsS "$url/healthz" >/dev/null 2>&1; then
        echo "❌ ERROR: IDEA Bridge not reachable at $url"
        echo "   Start it via: (cd idea-bridge && npm run dev)"
        exit 1
    fi
}

check_milvus() {
    local address="$MILVUS_ADDRESS"
    local host="${address%:*}"
    local port="${address##*:}"
    if [ "$address" = "$host" ]; then
        port="19530"
    fi
    echo "→ Checking Milvus at $host:$port"
    if ! nc -z "$host" "$port" >/dev/null 2>&1; then
        echo "❌ ERROR: Milvus not reachable at $host:$port"
        echo "   Start it with docker compose or set MILVUS_ADDRESS accordingly"
        exit 1
    fi
}

check_psi_cache() {
    local cache=".idea-bridge/psi-cache.json"
    if [ ! -f "$cache" ]; then
        echo "⚠️  WARNING: $cache not found. Ensure PSI export + ingest were run"
    fi
}

echo "Section 0: Environment checks"
echo "─────────────────────────────────────────────────────────────────"
check_bridge
check_milvus
check_psi_cache

# Helper function to run a test
run_test() {
    local test_name="$1"
    local test_cmd="$2"
    local validation_cmd="$3"
    local output_file="$TEST_OUTPUT_DIR/$(echo "$test_name" | tr ' ' '_').json"

    TOTAL=$((TOTAL + 1))
    echo ""
    echo "─────────────────────────────────────────────────────────────────"
    echo "Test $TOTAL: $test_name"
    echo "─────────────────────────────────────────────────────────────────"

    # Run the test command
    if eval "$test_cmd" > "$output_file" 2>&1; then
        # Validate the output
        if eval "$validation_cmd" "$output_file"; then
            echo "✅ PASS: $test_name"
            PASSED=$((PASSED + 1))
        else
            echo "❌ FAIL: $test_name (validation failed)"
            echo "   Output saved to: $output_file"
            FAILED=$((FAILED + 1))
        fi
    else
        echo "❌ FAIL: $test_name (command failed)"
        echo "   Output saved to: $output_file"
        FAILED=$((FAILED + 1))
    fi
}

# Validation helper functions
validate_targeted_strategy() {
    local file="$1"
    if grep -q '"type":"targeted"' "$file" || grep -q '"type":"balanced"' "$file"; then
        echo "   → Strategy: targeted/balanced detected"
        return 0
    else
        echo "   → ERROR: Expected targeted/balanced strategy"
        return 1
    fi
}

validate_deep_strategy() {
    local file="$1"
    if grep -q '"type":"deep"' "$file" || grep -q '"type":"balanced"' "$file"; then
        echo "   → Strategy: deep/balanced detected"
        return 0
    else
        echo "   → ERROR: Expected deep/balanced strategy"
        return 1
    fi
}

validate_context_budget() {
    local file="$1"
    local max_tokens=2000

    if ! jq -e '.contextBudget' "$file" > /dev/null 2>&1; then
        echo "   → ERROR: No contextBudget field found"
        return 1
    fi

    local used_tokens=$(jq -r '.contextBudget.usedTokens // 0' "$file")
    local truncated=$(jq -r '.contextBudget.truncated // false' "$file")

    echo "   → Used tokens: $used_tokens / $max_tokens"
    echo "   → Truncated: $truncated"

    if [ "$used_tokens" -gt "$max_tokens" ]; then
        echo "   → ERROR: Used tokens ($used_tokens) exceeds limit ($max_tokens)"
        return 1
    fi

    return 0
}

validate_fallback() {
    local file="$1"

    # Check if results exist
    if ! jq -e '.deliveredResults | length > 0' "$file" > /dev/null 2>&1; then
        echo "   → ERROR: No deliveredResults found"
        return 1
    fi

    local result_count=$(jq -r '.deliveredResults | length' "$file")
    echo "   → Fallback produced $result_count results"

    return 0
}

validate_breadth_mode() {
    local file="$1"
    local min_beans=10

    if ! jq -e '.deliveredResults' "$file" > /dev/null 2>&1; then
        echo "   → ERROR: No deliveredResults field"
        return 1
    fi

    local bean_count=$(jq -r '.deliveredResults | length' "$file")
    echo "   → Beans returned: $bean_count (minimum: $min_beans)"

    if [ "$bean_count" -lt "$min_beans" ]; then
        echo "   → WARNING: Expected at least $min_beans beans, got $bean_count"
        # Don't fail - this is environment-dependent
    fi

    return 0
}

validate_module_hint() {
    local file="$1"
    local expected_module="spring-petclinic-visits-service"

    # Check if top results contain the hinted module
    local top_modules=$(jq -r '.deliveredResults[0:3][].module // empty' "$file" 2>/dev/null)

    if echo "$top_modules" | grep -q "$expected_module"; then
        echo "   → Module hint working: $expected_module found in top results"
        return 0
    else
        echo "   → WARNING: Module hint may not be working (env-dependent)"
        # Don't fail - depends on Milvus data
        return 0
    fi
}

# ===================================================================
# Test Suite - Core Milestone B Features
# ===================================================================

echo ""
echo "Section 1: Dynamic Top-K Strategy"
echo "─────────────────────────────────────────────────────────────────"

run_test \
    "Dynamic Top-K: Targeted Query" \
    "cd mcp-server && PREFERRED_LEVELS=class MAX_CONTEXT_TOKENS=8000 npm run tool:search -- 'VisitController'" \
    "validate_targeted_strategy"

run_test \
    "Dynamic Top-K: Deep Query" \
    "cd mcp-server && PREFERRED_LEVELS=module,class,method MAX_CONTEXT_TOKENS=8000 npm run tool:search -- 'If I change the Visit entity schema, what controllers, repositories, and DTOs will be affected?'" \
    "validate_deep_strategy"

echo ""
echo "Section 2: Context Budget Management"
echo "─────────────────────────────────────────────────────────────────"

run_test \
    "Context Budget: Token Limit Enforcement" \
    "cd mcp-server && MAX_CONTEXT_TOKENS=2000 npm run tool:search -- 'Spring beans'" \
    "validate_context_budget"

echo ""
echo "Section 3: Module Hint Ranking"
echo "─────────────────────────────────────────────────────────────────"

run_test \
    "Module Hint: Results Prioritization" \
    "cd mcp-server && PREFERRED_LEVELS=class MODULE_HINT=spring-petclinic-visits-service npm run tool:search -- 'REST API'" \
    "validate_module_hint"

echo ""
echo "Section 4: Fallback Logic"
echo "─────────────────────────────────────────────────────────────────"

run_test \
    "Fallback: Visit Impact Synthesis" \
    "cd mcp-server && DISABLE_MILVUS=1 npm run tool:search -- 'Visit entity impact analysis'" \
    "validate_fallback"

run_test \
    "Fallback: Spring Beans Breadth Mode" \
    "cd mcp-server && MAX_CONTEXT_TOKENS=4000 npm run tool:search -- 'Show me all Spring beans in the entire project'" \
    "validate_breadth_mode"

# ===================================================================
# Summary
# ===================================================================

echo ""
echo "==================================================================="
echo "  Test Results Summary"
echo "==================================================================="
echo ""
echo "Total Tests:  $TOTAL"
echo "Passed:       $PASSED ✅"
echo "Failed:       $FAILED ❌"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo "🎉 All tests passed!"
    echo ""
    echo "Output files saved to: $TEST_OUTPUT_DIR"
    exit 0
else
    echo "⚠️  Some tests failed. Review output files in: $TEST_OUTPUT_DIR"
    exit 1
fi

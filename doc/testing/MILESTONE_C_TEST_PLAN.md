# Milestone C Test Plan & Verification Strategy

**Author**: Claude Code (claude.ai/code)
**Date**: 2025-12-02
**Purpose**: Define objective, executable tests to verify Codex's Milestone C claims in `BACKLOG.md`

---

## Executive Summary

Codex claims to have completed Milestone C items related to:
- **C.1**: Method-level indexing (`indexLevel = "method"`)
- **C.3**: Ranking B.1 improvements (AOP/Bean/BeanPostProcessor/Event scenarios)
- **C.4**: `analyze_callers_of_method` tool
- **C.5**: `analyze_callees_of_method` tool

This document defines **what "satisfactory" means** from the perspective of the actual MCP consumers (Claude Code and Codex) and provides executable tests to verify each claim.

---

## Testing Philosophy

### Core Principle: User-Centric Satisfaction

As the primary consumers of this MCP, we (Claude Code & Codex) define "satisfactory" as:

1. **Functional Correctness**: Features work as documented
2. **Semantic Quality**: Results are useful, not just technically correct
3. **Consistency**: Results are reproducible and stable
4. **Usability**: The feature helps us accomplish real tasks better than before

### Three-Tier Verification Strategy

```
Tier 1: Smoke Tests (5 min)
  → Does it run without crashing?
  → Does it return structurally valid results?

Tier 2: Quality Tests (15 min)
  → Are the results semantically relevant?
  → Do they meet our "good enough to use" bar?

Tier 3: Regression Tests (30 min)
  → Do Spring Framework queries still work?
  → Has ranking quality improved or degraded?
```

---

## Milestone C.1: Method-Level Index

### Claims to Verify

From `BACKLOG.md`:
- [x] Exports per-method structure (name, params, return type, visibility, annotations, javadoc)
- [x] Generates method-level embedding text (class + method sig + javadoc)
- [x] Writes to Milvus with `indexLevel = "method"`
- [x] MCP search pipeline includes `milvus-method` stage
- [x] C.1 experience validation on Spring Framework

### Test C.1.1: Method-Level Index Schema Validation

**Objective**: Verify PSI exports method-level data correctly

**Test Steps**:
```bash
# 1. Check PSI cache contains method-level data
python3 << 'EOF'
import json
import sys

cache_path = "idea-bridge/.idea-bridge/psi-cache.json"
with open(cache_path) as f:
    data = json.load(f)

symbols = data.get("symbols", [])
if not symbols:
    print("❌ FAIL: No symbols in PSI cache")
    sys.exit(1)

# Check first class with methods
class_with_methods = None
for sym in symbols:
    if sym.get("methods") and len(sym["methods"]) > 0:
        class_with_methods = sym
        break

if not class_with_methods:
    print("❌ FAIL: No classes with methods found")
    sys.exit(1)

method = class_with_methods["methods"][0]
required_fields = ["name", "signature", "visibility", "returnType", "parameters"]
missing = [f for f in required_fields if f not in method]

if missing:
    print(f"❌ FAIL: Method missing fields: {missing}")
    sys.exit(1)

print(f"✅ PASS: Method schema valid")
print(f"   Sample: {class_with_methods['fqn']}#{method['name']}")
sys.exit(0)
EOF
```

**Success Criteria**: Exit code 0, prints sample method FQN

---

### Test C.1.2: Milvus Method-Level Ingestion

**Objective**: Verify method-level entries exist in Milvus

**Test Steps**:
```bash
# Query Milvus for method-level entries
source .venv/bin/activate
cd idea-bridge
python3 << 'EOF'
from pymilvus import connections, Collection

connections.connect(alias="default", address="127.0.0.1:19530")
collection = Collection("idea_symbols_spring_jina")

# Query for method-level entries
expr = 'index_level == "method"'
results = collection.query(
    expr=expr,
    limit=10,
    output_fields=["fqn", "symbol_name", "summary", "index_level"]
)

if len(results) == 0:
    print("❌ FAIL: No method-level entries in Milvus")
    exit(1)

print(f"✅ PASS: Found {len(results)} method-level entries")
for r in results[:3]:
    print(f"   {r['fqn']}: {r['summary'][:60]}...")
exit(0)
EOF
```

**Success Criteria**:
- Exit code 0
- At least 10 method-level entries found
- FQN format is `ClassName#methodName`

---

### Test C.1.3: Method-Level Search Stage Active

**Objective**: Verify `milvus-method` stage returns results

**Test Steps**:
```bash
cd mcp-server
source ../.venv/bin/activate

# Query with method preference
PREFERRED_LEVELS=method \
MODULE_HINT=spring-aop \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does Spring AOP create dynamic proxies?" > /tmp/c1-method-test.json

# Validate output
python3 << 'EOF'
import json
import sys

with open("/tmp/c1-method-test.json") as f:
    result = json.load(f)

# Check for milvus-method stage
stages = result.get("stages", [])
method_stage = next((s for s in stages if s["name"] == "milvus-method"), None)

if not method_stage:
    print("❌ FAIL: No milvus-method stage in results")
    sys.exit(1)

if method_stage["hitCount"] == 0:
    print("❌ FAIL: milvus-method stage has 0 hits")
    sys.exit(1)

# Check delivered results
delivered = result.get("deliveredResults", [])
method_results = [r for r in delivered if r.get("indexLevel") == "method"]

if len(method_results) == 0:
    print("❌ FAIL: No method-level results delivered")
    sys.exit(1)

print(f"✅ PASS: milvus-method stage active with {method_stage['hitCount']} hits")
print(f"   Delivered {len(method_results)} method-level results")
for r in method_results[:2]:
    print(f"   - {r['fqn']}")
sys.exit(0)
EOF
```

**Success Criteria**:
- `stages` contains `"milvus-method"` with `hitCount > 0`
- At least 1 delivered result with `indexLevel: "method"`

---

### Test C.1.4: Method-Level Semantic Quality (The "Would We Use This?" Test)

**Objective**: Verify method-level results are actually useful for our work

**Test Query**: "How does AspectJAroundAdvice apply advice to a join point?"

**Expected Behavior**:
- Top 3 results should include methods from `AspectJAroundAdvice` or related AOP advice classes
- Should NOT be dominated by test utility methods
- Method signatures should be relevant to advice application

**Test Steps**:
```bash
cd mcp-server
source ../.venv/bin/activate

PREFERRED_LEVELS=class,method \
MODULE_HINT=spring-aop \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does AspectJAroundAdvice apply advice to a join point?" > /tmp/c1-quality-test.json

# Human-in-the-loop validation
echo "=== Top 5 Results ==="
jq -r '.deliveredResults[0:5] | .[] | "\(.indexLevel) | \(.fqn)\n  → \(.summary)\n"' /tmp/c1-quality-test.json

echo ""
echo "HUMAN VALIDATION REQUIRED:"
echo "1. Do the top results include AspectJAroundAdvice methods?"
echo "2. Are test methods penalized (not in top 3)?"
echo "3. Would you use these results to understand AOP advice?"
echo ""
echo "If YES to all: ✅ PASS"
echo "If NO to any:  ❌ FAIL - Update ranking logic"
```

**Success Criteria** (Human Judgment):
- ≥2 of top 5 are production AOP advice methods
- No test classes in top 3
- Results help answer the question

---

## Milestone C.3: Ranking B.1 Improvements

### Claims to Verify

From `BACKLOG.md`:
- [x] AOP/proxy scenario: Boost `*ProxyFactory*`, `*AopProxy*`, `*Advisor*` in `org.springframework.aop.*`
- [x] Bean scanning scenario: Boost `*BeanDefinitionScanner*`, `ClassPath*Scanning*`, `ComponentScan`
- [x] BeanPostProcessor scenario: Boost `*BeanPostProcessor*` with stronger TEST penalty
- [x] Event scenario: Boost `*EventListener*`, `*ApplicationEvent*`, `*EventMulticaster*`

### Test C.3.1: AOP Ranking Regression Test

**Objective**: Verify AOP queries return core proxy classes in top 5

**Test Steps**:
```bash
cd mcp-server
source ../.venv/bin/activate

PREFERRED_LEVELS=class \
MODULE_HINT=spring-aop \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does Spring AOP create dynamic proxies?" > /tmp/c3-aop-ranking.json

# Automated validation
python3 << 'EOF'
import json
import sys

with open("/tmp/c3-aop-ranking.json") as f:
    result = json.load(f)

top5_fqns = [r["fqn"] for r in result["deliveredResults"][:5]]

# Expected patterns
expected_patterns = [
    "ProxyFactory",
    "AopProxy",
    "Advisor",
    "ProxyCreator"
]

matches = sum(1 for fqn in top5_fqns if any(pat in fqn for pat in expected_patterns))

if matches < 2:
    print(f"❌ FAIL: Only {matches}/5 top results match AOP core classes")
    print(f"   Top 5: {top5_fqns}")
    sys.exit(1)

# Check for test pollution
test_count = sum(1 for r in result["deliveredResults"][:5] if "Test" in r["fqn"])
if test_count > 1:
    print(f"❌ FAIL: {test_count} test classes in top 5 (should be ≤1)")
    sys.exit(1)

print(f"✅ PASS: {matches}/5 top results are core AOP classes")
print(f"   Test pollution: {test_count}/5")
sys.exit(0)
EOF
```

**Success Criteria**:
- ≥2 of top 5 match expected patterns
- ≤1 test class in top 5

---

### Test C.3.2: BeanPostProcessor TEST Penalty

**Objective**: Verify test classes are strongly penalized in non-test queries

**Test Steps**:
```bash
cd mcp-server
source ../.venv/bin/activate

PREFERRED_LEVELS=class \
MODULE_HINT=spring-context \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "Show me BeanPostProcessor implementations" > /tmp/c3-bpp-ranking.json

# Validation
python3 << 'EOF'
import json
import sys

with open("/tmp/c3-bpp-ranking.json") as f:
    result = json.load(f)

top10 = result["deliveredResults"][:10]
test_count_top3 = sum(1 for r in top10[:3] if "Test" in r["fqn"])
test_count_top10 = sum(1 for r in top10 if "Test" in r["fqn"])

if test_count_top3 > 0:
    print(f"❌ FAIL: {test_count_top3} test classes in top 3")
    print(f"   Top 3: {[r['fqn'] for r in top10[:3]]}")
    sys.exit(1)

if test_count_top10 > 3:
    print(f"⚠️  WARN: {test_count_top10}/10 in top 10 are tests (acceptable but high)")

print(f"✅ PASS: No test classes in top 3")
print(f"   Test count in top 10: {test_count_top10}")
sys.exit(0)
EOF
```

**Success Criteria**:
- 0 test classes in top 3
- ≤3 test classes in top 10

---

### Test C.3.3: Event Scenario Ranking

**Objective**: Verify event-related queries surface correct infrastructure

**Test Steps**:
```bash
cd mcp-server
source ../.venv/bin/activate

PREFERRED_LEVELS=class \
MODULE_HINT=spring-context \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does Spring multicast application events?" > /tmp/c3-event-ranking.json

python3 << 'EOF'
import json
import sys

with open("/tmp/c3-event-ranking.json") as f:
    result = json.load(f)

top5_fqns = [r["fqn"] for r in result["deliveredResults"][:5]]

# Expected: ApplicationEventMulticaster, EventListener infrastructure
expected_patterns = [
    "EventMulticaster",
    "EventListener",
    "ApplicationEvent"
]

matches = sum(1 for fqn in top5_fqns if any(pat in fqn for pat in expected_patterns))

if matches < 2:
    print(f"❌ FAIL: Only {matches}/5 top results are event infrastructure")
    print(f"   Top 5: {top5_fqns}")
    sys.exit(1)

print(f"✅ PASS: {matches}/5 top results are event-related")
sys.exit(0)
EOF
```

**Success Criteria**: ≥2 of top 5 match event infrastructure patterns

---

## Milestone C.4: `analyze_callers_of_method`

### Claims to Verify

From `BACKLOG.md`:
- [x] Tool accepts `methodFqn`, `excludeTest`, `maxResults`
- [x] Reads PSI cache `relations.calls` (class-level aggregation)
- [x] Falls back to `relations.references` if no direct calls
- [x] Supports `excludeTest` filter
- [x] Returns `callers[]` with `classFqn/module/packageName/filePath/isTest`

### Test C.4.1: Direct Call Analysis

**Objective**: Verify tool finds direct callers correctly

**Test Steps**:
```bash
cd mcp-server
npm run build

# Test with known method
node << 'EOF'
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const mcpServer = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "analyze_callers_of_method",
    arguments: {
      methodFqn: "org.springframework.jdbc.core.JdbcTemplate#query",
      excludeTest: true,
      maxResults: 10
    }
  }
};

mcpServer.stdin.write(JSON.stringify(request) + '\n');

let output = '';
mcpServer.stdout.on('data', (data) => {
  output += data.toString();
});

setTimeout(() => {
  mcpServer.kill();

  try {
    const lines = output.split('\n').filter(l => l.trim());
    const response = JSON.parse(lines[lines.length - 1]);

    if (response.error) {
      console.log("❌ FAIL: Tool returned error:", response.error);
      process.exit(1);
    }

    const result = JSON.parse(response.result.content[0].text);

    if (!result.callers || result.callers.length === 0) {
      console.log("❌ FAIL: No callers found");
      process.exit(1);
    }

    console.log(`✅ PASS: Found ${result.callers.length} callers`);
    console.log(`   Sample: ${result.callers[0].classFqn}`);
    process.exit(0);
  } catch (e) {
    console.log("❌ FAIL: Could not parse response:", e);
    process.exit(1);
  }
}, 3000);
EOF
```

**Success Criteria**:
- Exit code 0
- `callers[]` contains ≥1 entry
- Each caller has required fields

---

### Test C.4.2: Test Exclusion Filter

**Objective**: Verify `excludeTest` actually filters test classes

**Test Steps**:
```bash
# Same as C.4.1 but check for test pollution
# Expected: All returned callers should have isTest: false
# Verify manually by checking filePaths don't contain "/test/"
```

**Success Criteria**:
- All callers have `isTest: false`
- No `filePath` contains `/test/`

---

## Milestone C.5: `analyze_callees_of_method`

### Claims to Verify

From `BACKLOG.md`:
- [x] Tool accepts `methodFqn`, `maxResults`
- [x] Reads PSI cache `relations.calls` (class-aggregated)
- [x] Falls back to `relations.references`
- [x] Categorizes callees (DB/HTTP/REDIS/MQ/EVENT/FRAMEWORK/etc.)
- [x] Lists implementations for interface callees

### Test C.5.1: Outgoing Call Analysis

**Objective**: Verify tool finds outgoing calls and categorizes them

**Test Steps**:
```bash
# Similar MCP invocation as C.4.1
# Validate:
# - callees[] is non-empty
# - Each callee has 'category' field
# - Categories make sense (e.g., JdbcTemplate calls should include DB category)
```

**Success Criteria**:
- `callees[]` contains ≥1 entry
- All callees have valid `category` enum value
- At least one callee is correctly categorized (manual spot-check)

---

## Integration Test: End-to-End Workflow

### Test INT.1: Real-World AOP Migration Scenario

**Scenario**: "I need to find all production code that calls `ProxyFactory.createAopProxy` to understand impact of refactoring"

**Test Steps**:
```bash
# 1. Find the method using semantic search
PREFERRED_LEVELS=method \
MODULE_HINT=spring-aop \
npm run tool:search -- "ProxyFactory createAopProxy" > /tmp/int-aop-search.json

# 2. Extract method FQN from top result
METHOD_FQN=$(jq -r '.deliveredResults[0].fqn' /tmp/int-aop-search.json)

# 3. Analyze callers
# (Use MCP call to analyze_callers_of_method with METHOD_FQN)

# 4. Validate workflow
# - Search returned correct method
# - Callers analysis returned production callers
# - No test classes in caller list (excludeTest=true)
```

**Success Criteria** (Human):
- Workflow completes without errors
- Results are actionable (we would actually use this for migration planning)

---

## Automated Test Harness

### Test Script: `scripts/verify-milestone-c.sh`

Create an executable script that runs all automated tests:

```bash
#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local script="$2"

  echo "→ Running: $name"
  if eval "$script"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
  echo ""
}

# Run all automated tests
run_test "C.1.1 Method Schema" "..."
run_test "C.1.2 Milvus Ingestion" "..."
# ... etc

echo "===================="
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  echo "✅ All automated tests passed"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
```

---

## What "Satisfactory" Means (Final Definition)

From Claude Code's perspective, Milestone C is **satisfactory** if:

### Hard Requirements (Must Pass)
1. All smoke tests (Tier 1) pass
2. Method-level index is queryable via MCP
3. Caller/callee tools return valid data without crashing
4. Test exclusion filters work correctly

### Soft Requirements (Quality Thresholds)
5. ≥70% of quality tests pass (Tier 2)
6. AOP/Bean/Event ranking puts relevant classes in top 5
7. Test pollution is ≤20% in top 10 results (non-test queries)
8. Method-level results are "good enough to use" in 2/3 sample queries

### Usability Bar
9. We (Claude Code & Codex) would actually use these features in real work
10. Features save us time compared to manual code navigation
11. Results don't require heavy manual filtering to be useful

---

## Acceptance Decision Tree

```
┌─────────────────────────────┐
│ All Tier 1 tests pass?      │
└──────┬──────────────────────┘
       │ NO → ❌ REJECT (fix critical bugs)
       │ YES ↓
┌─────────────────────────────┐
│ ≥70% Tier 2 tests pass?     │
└──────┬──────────────────────┘
       │ NO → ⚠️  CONDITIONAL (needs improvement)
       │ YES ↓
┌─────────────────────────────┐
│ Would we use this in prod?  │
└──────┬──────────────────────┘
       │ NO → ⚠️  CONDITIONAL (polish needed)
       │ YES ↓
       ✅ ACCEPT: Milestone C complete
```

---

## Next Steps

1. **Run automated test suite**: `./scripts/verify-milestone-c.sh`
2. **Manual quality review**: Run spot-checks on AOP/Bean/Event queries
3. **Update BACKLOG.md**: Change ✅ to ✓ (confirmed) or ⚠️ (needs work)
4. **Document findings**: Add results to `doc/MILESTONE_C_STATUS.md`

---

**Appendix: Why This Matters**

This isn't bureaucratic testing for its own sake. We're the actual users of this MCP. If we can't trust the results, we won't use it. If ranking is poor, we'll waste time filtering noise. This test plan ensures the system is genuinely useful, not just "technically implemented."

The bar is: **Would Claude Code trust these results when helping users refactor Spring code?**

If yes → ✅ Ship it
If no → 🔧 Improve it

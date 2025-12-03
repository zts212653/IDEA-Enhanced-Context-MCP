# Milestone C Verification - Quick Start Guide

**Created by**: Claude Code
**Date**: 2025-12-02
**Purpose**: Verify Codex's Milestone C implementation claims

---

## TL;DR - Run the Tests

```bash
# Quick smoke tests only (5 min)
./scripts/verify-milestone-c.sh --quick

# Full test suite including quality checks (15 min)
./scripts/verify-milestone-c.sh --full
```

---

## What This Verifies

Codex claims to have completed:

### C.1 - Method-Level Indexing
- ✅ PSI exports method-level metadata
- ✅ Milvus contains `indexLevel = "method"` entries
- ✅ MCP search returns `milvus-method` stage
- ✅ Method-level results are semantically useful

### C.3 - Ranking B.1 Improvements
- ✅ AOP queries prioritize ProxyFactory/AopProxy/Advisor
- ✅ Bean scanning queries prioritize BeanDefinitionScanner/ComponentScan
- ✅ BeanPostProcessor queries penalize test classes
- ✅ Event queries prioritize EventMulticaster/EventListener

### C.4 - analyze_callers_of_method
- ✅ Tool finds direct callers via PSI relations.calls
- ✅ Falls back to relations.references if needed
- ✅ excludeTest filter works correctly

### C.5 - analyze_callees_of_method
- ✅ Tool finds outgoing calls
- ✅ Categorizes calls (DB/HTTP/MQ/etc.)
- ✅ Lists implementations for interface callees

---

## Prerequisites

### 1. Environment Setup

```bash
# Python venv with pymilvus
python3 -m venv .venv
source .venv/bin/activate
pip install pymilvus

# Node.js dependencies
cd mcp-server && npm install && npm run build
cd ../idea-bridge && npm install && npm run build
```

### 2. Milvus Running

```bash
# Check Milvus is accessible
python3 << 'EOF'
from pymilvus import connections, Collection
connections.connect(alias="default", address="127.0.0.1:19530")
print(f"Collections: {Collection.list_all()}")
EOF

# Expected output: idea_symbols_spring_jina (or similar)
```

### 3. PSI Cache Present

```bash
# Check PSI cache exists
ls -lh idea-bridge/.idea-bridge/psi-cache.json

# Should be > 1MB (Spring Framework has ~76k entries)
```

---

## Running the Tests

### Quick Mode (Tier 1 Only)

Runs critical smoke tests - verifies features exist and don't crash:

```bash
./scripts/verify-milestone-c.sh --quick
```

**Expected output**:
```
================================================================
  Tier 1: Smoke Tests
================================================================

-------------------------------------------------------------------
  TEST 1: C.1.1 - PSI Cache Method Schema
-------------------------------------------------------------------
✅ PASS: PSI cache contains valid method-level data

-------------------------------------------------------------------
  TEST 2: C.1.2 - Milvus Method-Level Ingestion
-------------------------------------------------------------------
✅ PASS: Milvus contains method-level entries

... (5-7 smoke tests)

================================================================
  Test Results Summary
================================================================

Total Tests:  7
Passed:       7 ✅
Failed:       0 ❌
Skipped:      3 ⏭

🎉 ALL TESTS PASSED
```

### Full Mode (Tier 1 + Tier 2)

Includes semantic quality validation:

```bash
./scripts/verify-milestone-c.sh --full
```

**Additional tests**:
- AOP query returns ProxyFactory in top 5
- BeanPostProcessor query has 0 test classes in top 3
- Event query returns EventMulticaster in top 5

**Expected runtime**: 10-15 minutes

---

## Interpreting Results

### Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | All tests passed | ✅ Accept Milestone C |
| 1 | < 70% pass rate | ❌ Reject - needs fixes |
| 2 | 70-99% pass rate | ⚠️ Conditional - review failures |

### Pass Rate Thresholds

```
100%     → ✅ ACCEPT (ship it!)
70-99%   → ⚠️ CONDITIONAL (review failed tests)
< 70%    → ❌ REJECT (critical issues)
```

### What "Satisfactory" Means

From our (Claude Code & Codex) perspective as MCP consumers:

**Hard Requirements**:
- Features don't crash
- Data structure is valid
- Basic functionality works

**Soft Requirements**:
- Results are semantically relevant
- Ranking puts good stuff in top 5
- Test pollution is < 20% in non-test queries

**Usability Bar**:
- We would actually use this in production
- Saves time vs manual navigation
- Doesn't require heavy filtering

---

## Common Issues & Solutions

### Issue: Milvus Connection Failed

```
ERROR: Fail connecting to server on 127.0.0.1:19530
```

**Solution**:
```bash
# Start Milvus via Docker
docker run -d --name milvus \
  -p 19530:19530 \
  -p 9091:9091 \
  milvusdb/milvus:latest

# Wait 30s for startup
sleep 30
```

### Issue: No Method-Level Entries in Milvus

```
ERROR: No method-level entries in Milvus
```

**Solution**:
```bash
# Re-ingest PSI cache into Milvus
cd idea-bridge
npm run ingest:milvus

# This may take 5-10 minutes for Spring Framework
```

### Issue: PSI Cache Not Found

```
ERROR: PSI cache not found at idea-bridge/.idea-bridge/psi-cache.json
```

**Solution**:
```bash
# Export PSI from IntelliJ IDEA
# 1. Open Spring Framework in IDEA
# 2. Run: Tools > Export PSI to Bridge
# 3. Wait for upload to complete
# OR use existing backup:
cp idea-bridge/.idea-bridge/spring-framework-psi-cache.json \
   idea-bridge/.idea-bridge/psi-cache.json
```

### Issue: npm run tool:search Hangs

```
(Command hangs for > 30 seconds)
```

**Solution**:
```bash
# Check if IDEA Bridge is running
curl http://127.0.0.1:3100/healthz

# If not, start it:
cd idea-bridge
npm run dev
```

---

## Manual Spot Checks (Optional)

For human-in-the-loop validation:

### Check 1: Method-Level Search Quality

```bash
cd mcp-server
source ../.venv/bin/activate

PREFERRED_LEVELS=method \
MODULE_HINT=spring-aop \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does AspectJAroundAdvice apply advice?" | \
  jq -r '.deliveredResults[0:5] | .[] | "\(.fqn)\n  → \(.summary)\n"'
```

**Expected**: Top results include methods from `AspectJAroundAdvice` like `lazyGetProceedingJoinPoint`

### Check 2: Caller Analysis

```bash
cd mcp-server

# Find callers of JdbcTemplate#query
BRIDGE_PSI_CACHE=../idea-bridge/.idea-bridge/psi-cache.json \
node << 'EOF'
import('./dist/callersAnalysis.js').then(mod => {
  const result = mod.analyzeCallers({
    methodFqn: 'org.springframework.jdbc.core.JdbcTemplate#query',
    excludeTest: true,
    maxResults: 10
  });
  console.log('Callers:', result.callers.map(c => c.classFqn));
});
EOF
```

**Expected**: List includes `NamedParameterJdbcTemplate`, `SimpleJdbcCall`, etc.

### Check 3: Ranking Quality Visual Inspection

```bash
cd mcp-server
source ../.venv/bin/activate

PREFERRED_LEVELS=class \
MODULE_HINT=spring-context \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "BeanPostProcessor implementations" | \
  jq -r '.deliveredResults[0:10] | .[] | "\(.fqn) (test: \((.fqn | contains("Test"))))"'
```

**Expected**: Top 3 should NOT contain "Test" in FQN

---

## What Happens Next?

### If All Tests Pass (Exit 0)

1. Update `BACKLOG.md`:
   ```markdown
   - [✅] C.1 Method-level index → [✓] C.1 Method-level index (verified 2025-12-02)
   ```

2. Update `AI_CHANGELOG.md`:
   ```markdown
   ## 2025-12-02 - Claude Code

   - Verified Milestone C implementation (all tests pass)
   - Created automated test suite: scripts/verify-milestone-c.sh
   - Documented verification criteria in tmp/milestone-b-tests/
   ```

3. Close Milestone C in project tracking

### If Tests Fail (Exit 1 or 2)

1. Review failure logs in `tmp/milestone-c-tests/`
2. Identify root cause (code bug, data issue, or ranking tuning needed)
3. Create GitHub issue with failure details
4. Fix and re-run tests

---

## Files Created by This Verification

```
tmp/milestone-b-tests/
├── MILESTONE_C_TEST_PLAN.md      # Detailed test design & rationale
├── VERIFY_MILESTONE_C_README.md  # This file (quick start)

scripts/
├── verify-milestone-c.sh         # Executable test suite

tmp/milestone-c-tests/            # Test output logs
├── c1.2-milvus-method-check.log
├── c1.3-method-search.json
├── c3.1-aop-ranking.json
├── c3.2-bpp-ranking.json
├── c3.3-event-ranking.json
└── c4.1-callers-smoke.log
```

---

## Why This Matters

This isn't bureaucratic testing. We're the actual users of this MCP server. If the results aren't useful, we won't use it.

The tests answer:
- **Does it work?** (Tier 1)
- **Is it any good?** (Tier 2)
- **Would we trust it in production?** (Human judgment)

The bar is simple: **Would Claude Code rely on these results when helping users refactor Spring code?**

If yes → Ship it
If no → Improve it

---

## Quick Reference

```bash
# Full verification flow
source .venv/bin/activate
./scripts/verify-milestone-c.sh --full

# Check specific component
cd mcp-server && npm run tool:search -- "your query here"

# Inspect Milvus
python3 -c "from pymilvus import *; connections.connect(); print(Collection.list_all())"

# View logs
ls -lh tmp/milestone-c-tests/
```

---

**Ready to verify?** Run `./scripts/verify-milestone-c.sh --full` and let the tests decide! 🚀

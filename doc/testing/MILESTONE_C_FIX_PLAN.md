# Milestone C Test Failures - Root Cause Analysis & Fix Plan

**Date**: 2025-12-02
**Analyzers**: Codex (test execution) + Claude Code (root cause analysis)
**Issue**: C.3.1 (AOP ranking) and C.3.3 (Event ranking) tests failed

---

## 🔴 Test Failure Summary

### Failed Tests
- **C.3.1 AOP Ranking**: Expected ProxyFactory/AopProxy in top 5, got MessageSource/BindingResult from spring-context
- **C.3.3 Event Ranking**: Expected EventMulticaster, got MessageSource/ApplicationObjectSupport from wrong modules

### Passed Tests
- ✅ C.1.1: PSI cache method schema
- ✅ C.1.2: Milvus method-level ingestion
- ✅ C.1.3: milvus-method stage active
- ✅ C.3.2: BeanPostProcessor test penalty (0 tests in top 3)
- ✅ C.4.1/C.5.1: Caller/callee tools exist

---

## 🔍 Root Cause Analysis

### Symptom
```json
// Test C.3.1: AOP query with moduleHint: "spring-aop"
{
  "query": "How does Spring AOP create dynamic proxies?",
  "moduleHint": "spring-aop",  // ← User explicitly specified spring-aop
  "deliveredResults": [
    { "fqn": "MessageSource", "module": "spring-context" },      // ❌ Wrong module!
    { "fqn": "BindingResult", "module": "spring-messaging" },    // ❌ Wrong module!
    { "fqn": "ApplicationObjectSupport", "module": "spring-context" }  // ❌ Wrong module!
  ],
  "stages": [
    { "name": "milvus-class", "hitCount": 6 }
  ]
}
```

**Expected**: Top results from `spring-aop` module (ProxyFactory, AopProxy, etc.)
**Actual**: Top results from `spring-context` and `spring-messaging` modules

### The Bug: `moduleHint` Never Reaches Milvus

**Code path**:
```
User input (moduleHint: "spring-aop")
  ↓
searchPipeline.ts:1906
  moduleFilter: profile.moduleFilter ?? args.moduleFilter  // ← moduleHint not used!
  ↓
milvusClient.ts:258
  moduleFilter: args.moduleFilter  // ← Only moduleFilter passed
  ↓
milvus_query.py:32-34
  if module_filter:
      expr_parts.append(f'module_name == "{module_filter}"')  // ← Never executes!
  ↓
Milvus query runs WITHOUT module filtering
  ↓
Returns semantically similar results from ALL modules
```

**The critical bug**: In `searchPipeline.ts:1903-1907`:
```typescript
const baseMilvusArgs: SearchArguments = {
  ...rankingArgs,
  moduleHint: strategy.moduleHint ?? args.moduleHint,  // ← Set but not used!
  moduleFilter: profile.moduleFilter ?? args.moduleFilter,  // ← Usually undefined
};
```

Then in `milvusClient.ts:253-259`:
```typescript
const rows = await runPythonSearch({
  // ... other args
  moduleFilter: args.moduleFilter,  // ❌ BUG: Should be moduleFilter ?? moduleHint
  levels: args.preferredLevels ?? ["class", "method"],
});
```

**Result**: Milvus searches across ALL modules, ignoring user's `moduleHint`.

---

## 🔧 Fix Plan

### Priority 1: Make `moduleHint` Filter Milvus Results

**File**: `mcp-server/src/milvusClient.ts`
**Line**: 258

**Current code**:
```typescript
moduleFilter: args.moduleFilter,
```

**Fixed code**:
```typescript
moduleFilter: args.moduleFilter ?? args.moduleHint,  // Fallback to moduleHint
```

**Rationale**:
- `moduleFilter` is a hard filter (user wants ONLY this module)
- `moduleHint` is a soft hint (user prefers this module, but it should still act as a filter in Milvus)
- Currently, `moduleHint` does nothing in the recall stage
- After fix: `moduleHint` becomes an effective module filter for Milvus queries

**Impact**:
- AOP query with `moduleHint: "spring-aop"` will only search `module_name == "spring-aop"` in Milvus
- Event query with `moduleHint: "spring-context"` will only return spring-context results
- Ranking B.1 boosts (ProxyFactory, EventMulticaster, etc.) can then work on correct candidates

---

### Priority 2: Verify `rankSymbols` Module Boost

**File**: `mcp-server/src/searchPipeline.ts`
**Line**: 177-178

**Current code**:
```typescript
const moduleBoost =
  preferredModule && symbol.module === preferredModule ? 0.1 : 0;
```

Where `preferredModule = args.moduleFilter ?? args.moduleHint` (line 139).

**Analysis**: This is correct! Once Milvus returns correct modules, this boost will work.

**No change needed**, but verify after Priority 1 fix.

---

### Priority 3: Add Debug Logging for Module Filtering

**File**: `mcp-server/src/milvusClient.ts`
**After line**: 258

**Add**:
```typescript
if (args.moduleFilter || args.moduleHint) {
  console.error(
    `[milvus] Filtering by module: ${args.moduleFilter ?? args.moduleHint}`
  );
}
```

**Rationale**: Make it obvious when module filtering is active, for debugging future issues.

---

### Priority 4: Document `moduleHint` vs `moduleFilter` Semantics

**File**: `mcp-server/src/searchPipeline.ts`
**Add comment** around line 9:

```typescript
export type SearchArguments = {
  query: string;
  limit?: number;

  // Module filtering:
  // - moduleFilter: HARD filter - only return results from this module (exclusive)
  // - moduleHint: SOFT hint - prefer this module in ranking AND use as Milvus filter
  //   Note: moduleHint is treated as a filter at Milvus level (Priority 1 fix),
  //   then boosted in ranking (line 177-178). This ensures recall is scoped correctly.
  moduleFilter?: string;
  moduleHint?: string;

  preferredLevels?: string[];
  // ...
};
```

---

## 🧪 Verification Plan

### Step 1: Apply Priority 1 Fix

```bash
# Edit mcp-server/src/milvusClient.ts line 258
moduleFilter: args.moduleFilter ?? args.moduleHint,

# Rebuild
cd mcp-server && npm run build
```

### Step 2: Re-run Failed Tests

```bash
source .venv/bin/activate
./scripts/verify-milestone-c.sh --full
```

**Expected changes**:
- C.3.1 (AOP): Should now return ProxyFactory/AopProxy from spring-aop → **PASS**
- C.3.3 (Event): Should now return EventMulticaster from spring-context → **PASS**

### Step 3: Manual Spot Check

```bash
cd mcp-server
PREFERRED_LEVELS=class \
MODULE_HINT=spring-aop \
DISABLE_SCHEMA_CHECK=1 \
npm run tool:search -- "How does Spring AOP create dynamic proxies?" | \
  jq -r '.deliveredResults[0:5] | .[] | "\(.module) | \(.fqn)"'
```

**Expected output**:
```
spring-aop | org.springframework.aop.framework.ProxyFactory
spring-aop | org.springframework.aop.framework.AopProxy
spring-aop | org.springframework.aop.framework.DefaultAopProxyFactory
spring-aop | org.springframework.aop.framework.autoproxy.AbstractAutoProxyCreator
spring-aop | org.springframework.aop.Advisor
```

All modules should be `spring-aop`, not `spring-context`.

---

## 🤔 Why Codex's Analysis Was Correct

Codex identified:
1. ✅ **召回阶段问题**: `moduleHint` 完全没起过滤作用
2. ✅ **排序无用武之地**: Ranking B.1 的 AOP boost 无法生效（因为没有 AOP 类可供 boost）
3. ✅ **优先级正确**: 先修召回，再看排序

This matches our root cause analysis exactly!

---

## 📊 Impact Assessment

### Before Fix
- `moduleHint` is decorative (doesn't filter Milvus results)
- User asks for spring-aop classes → gets spring-context classes
- Ranking B.1 semantic boosts are wasted on wrong modules

### After Fix (Priority 1 Only)
- `moduleHint` filters Milvus at SQL level (`module_name == "spring-aop"`)
- Ranking B.1 boosts work on correct candidate set
- User gets expected results in top 5

### Risk Assessment
**Low risk**:
- One-line change with clear semantics
- Fallback behavior: `moduleFilter ?? moduleHint` preserves existing `moduleFilter` priority
- If both are undefined, behavior is unchanged (no filter)

---

## 🎯 Alternative Approaches (Rejected)

### Alternative 1: Make `moduleHint` Only a Ranking Signal
**Approach**: Keep Milvus unfiltered, boost `moduleHint` modules in ranking.

**Rejected because**:
- Wastes Milvus query budget on irrelevant modules
- Ranking boosts (+0.1) can't overcome strong semantic similarity from wrong modules
- User intent with `moduleHint: "spring-aop"` is clearly "search within spring-aop"

### Alternative 2: Add Separate `milvusModuleFilter` Parameter
**Approach**: New parameter specifically for Milvus filtering.

**Rejected because**:
- Adds complexity without benefit
- `moduleHint` already expresses user intent
- Semantic confusion: "What's the difference between moduleHint and milvusModuleFilter?"

### Alternative 3: Apply Module Filter Post-Recall in Ranking
**Approach**: Let Milvus return all modules, filter in `rankSymbols()`.

**Rejected because**:
- Wastes Milvus top-k budget (e.g., top 20 might be all spring-context, filtering leaves 0 spring-aop)
- Less efficient than SQL-level filtering
- Doesn't solve the core issue (wrong recall)

---

## 📝 Implementation Checklist

- [ ] **Priority 1**: Change `milvusClient.ts:258` to `moduleFilter ?? moduleHint`
- [ ] **Priority 2**: Rebuild MCP server (`npm run build`)
- [ ] **Priority 3**: Re-run `./scripts/verify-milestone-c.sh --full`
- [ ] **Priority 4**: Verify C.3.1 and C.3.3 now pass
- [ ] **Priority 5**: Add debug logging for module filter (optional but recommended)
- [ ] **Priority 6**: Document semantics in code comments
- [ ] **Priority 7**: Update `AI_CHANGELOG.md` with fix details
- [ ] **Priority 8**: Commit with message: `fix: honor moduleHint in Milvus filtering`

---

## 🚀 Expected Outcome

After applying Priority 1 fix:

### Test Results
```
================================================================
  Test Results Summary
================================================================

Total Tests:  8
Passed:       8 ✅
Failed:       0 ❌
Skipped:      0 ⏭

🎉 ALL TESTS PASSED

Milestone C verification: ✅ ACCEPT
```

### Real-World Usage
```typescript
// User query
{
  query: "How does Spring AOP create proxies?",
  moduleHint: "spring-aop"
}

// Before fix: Returns MessageSource from spring-context ❌
// After fix: Returns ProxyFactory from spring-aop ✅
```

---

## 🎓 Lessons Learned

1. **Parameter naming matters**: `moduleHint` implies "soft preference" but user expectation is "hard filter"
2. **Test early, test often**: This bug would have been caught in manual testing if we ran verification earlier
3. **Multi-agent debugging works**: Codex ran tests, Claude analyzed root cause, together we found the one-line fix
4. **Documentation prevents bugs**: If `moduleHint` semantics were documented, this might not have happened

---

## Next Steps

1. **Human decision**: Approve Priority 1 fix (one-line change, low risk)
2. **Codex**: Apply fix, rebuild, re-run tests
3. **Claude Code**: Verify test results, update BACKLOG.md if all pass
4. **Both**: Document in AI_CHANGELOG.md

---

**Bottom line**: One-line fix, huge impact. Let's ship it! 🚀

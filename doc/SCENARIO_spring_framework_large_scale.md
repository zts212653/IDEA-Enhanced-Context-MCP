# Spring Framework Large-Scale Codebase Scenarios

**Context**: Testing MCP capabilities on Spring Framework (80,000+ entries) vs spring-petclinic (500 entries)

**Goal**: Demonstrate that MCP's value proposition scales with codebase complexity

---

## Why Spring Framework (8w entries) Tests Matter

### Scale Comparison

| Metric | Petclinic | Spring Framework | Multiplier |
|--------|-----------|------------------|------------|
| Symbol Count | ~500 | ~80,000 | **160x** |
| Module Count | 5 | 20+ | **4x** |
| Class Hierarchy Depth | 2-3 levels | 5-10 levels | **3x** |
| Typical Search Results | 10-20 | 500-5000 | **100x** |

### Pain Points Only Visible at Scale

1. **Module-level filtering becomes critical**
   - Petclinic: 5 modules → manual filtering acceptable
   - Spring Framework: 20+ modules → must have `moduleHint` to avoid noise

2. **Context budget management becomes essential**
   - Petclinic: "Spring beans" → 10 results, can return all
   - Spring Framework: "Spring beans" → 5000 results, **must truncate intelligently**

3. **Semantic search quality gap widens**
   - Petclinic: Class names are self-explanatory (`VisitController`)
   - Spring Framework: Abstract names (`AbstractHandlerMethodMapping`) → need hierarchy/relations metadata

4. **Query performance matters**
   - Petclinic: Even naive full-scan is < 1s
   - Spring Framework: Without module-level staging, queries timeout

---

## Test Scenarios

### Test 1: Module Navigation

**Query**: "What are the core modules in Spring Framework and their main responsibilities?"

**What We're Testing**:
- Module-level staging (Stage 1 should return 15-20 modules)
- Context budget control (should fit in 6000 tokens despite 80k entries)
- Module dependency graph

**Success Criteria**:
- ✅ Returns `spring-core`, `spring-beans`, `spring-context` in top results
- ✅ Each module has `packages`, `springBeans`, `dependencies` metadata
- ✅ `usedTokens` < `maxTokens`

**Why Petclinic Can't Test This**:
- Only 5 modules, no complex dependencies
- Module graph is trivial (all services are peers)

---

### Test 2: Semantic Search Quality

**Query**: "How does Spring scan and register beans automatically?"

**What We're Testing**:
- Semantic understanding vs keyword matching
- Hierarchy metadata (inheritance chains)
- Filtering out test/example code

**Success Criteria**:
- ✅ Returns `ClassPathBeanDefinitionScanner` (core scanner)
- ✅ Returns `ComponentScanAnnotationParser` (annotation handler)
- ❌ Does NOT return `BeanPostProcessor` (related but not "scanning")
- ✅ Hierarchy shows inheritance from `ClassPathScanningCandidateComponentProvider`

**Why Petclinic Can't Test This**:
- No custom bean scanning logic (only uses standard `@Component`)
- Inheritance hierarchies are shallow (1-2 levels)

---

### Test 3: Context Budget at Scale

**Query**: "Show me all classes that implement BeanPostProcessor in production code"

**What We're Testing**:
- Context budget truncation with 50+ results
- Production code prioritization over tests
- Breadth vs depth trade-off

**Success Criteria**:
- ✅ Returns 50+ implementations (Spring Framework has many)
- ✅ `contextBudget.truncated = true`
- ✅ `omittedCount > 0`
- ✅ Top 5 results are production classes (not tests)
- ✅ Each result is summary-only (no full code → saves tokens)

**Why Petclinic Can't Test This**:
- Only ~10 beans total, no interface with 50+ implementations
- Context budget never gets stressed

---

### Test 4: Hierarchy Visualization

**Query**: "What are the main classes for creating AOP proxies?"

**What We're Testing**:
- Hierarchy metadata (extends/implements)
- Design pattern recognition (Strategy pattern)
- Module-specific search (`spring-aop`)

**Success Criteria**:
- ✅ Returns `ProxyFactory`, `JdkDynamicAopProxy`, `CglibAopProxy`
- ✅ Hierarchy shows both implement `AopProxy` interface
- ✅ Can trace decision tree: ProxyFactory → AopProxyFactory → choose JDK/CGLIB

**Why Petclinic Can't Test This**:
- No AOP usage (no custom proxies)
- No strategy pattern implementations

---

### Test 5: Module Filtering Performance

**Query**: "request mapping" with `MODULE_HINT=spring-webmvc`

**What We're Testing**:
- Module hint ranking boost
- Query performance with module filter
- False positive suppression (exclude `spring-web`, `spring-test`)

**Success Criteria**:
- ✅ Query time < 3s (even with 80k entries)
- ✅ Top 5 results ALL from `spring-webmvc`
- ✅ `RequestMappingHandlerMapping` in top 3
- ✅ Results from other modules ranked lower

**Why Petclinic Can't Test This**:
- All web code in one module (`spring-petclinic-api-gateway`)
- No module disambiguation needed

---

## Value Proposition at Scale

| Capability | Petclinic (500) | Spring Framework (80k) | Value Increase |
|------------|-----------------|------------------------|----------------|
| Module filtering | Nice to have | **Critical** | 10x |
| Context budget | Rarely needed | **Always needed** | 100x |
| Semantic search | Helpful | **Game-changer** | 50x |
| Hierarchy metadata | Minor benefit | **Essential** | 20x |
| Query performance | Always fast | **Must optimize** | 10x |

---

## Running the Test Suite

```bash
# Option 1: Auto-start all dependencies
./scripts/test-spring-framework.sh /path/to/spring-framework

# Option 2: Use cached PSI data (no path needed)
./scripts/test-spring-framework.sh

# Option 3: Custom Bridge port
IDEA_BRIDGE_PORT=8080 ./scripts/test-spring-framework.sh
```

**Prerequisites**:
1. Spring Framework cloned locally
2. PSI data exported via IntelliJ plugin action
3. Milvus running with indexed data (or use fallback mode)

**Output**:
- Test results: `/tmp/spring-framework-tests/*.json`
- Bridge logs: `/tmp/spring-framework-tests/idea-bridge.log`

---

## Expected Findings

### What Should Work Well

1. **Module-level navigation** - Returns 15-20 modules with clear responsibilities
2. **Context budget** - Truncates large result sets intelligently
3. **Semantic search** - Finds "bean scanning" classes without keyword matching
4. **Performance** - Query time < 5s even with 80k entries

### What Might Need Improvement

1. **Hierarchy metadata completeness** - May not capture all extends/implements relationships
2. **Test code filtering** - May still return some test classes in top results
3. **Module hint effectiveness** - Ranking boost may need tuning
4. **Dynamic Top-K calibration** - May over/under-estimate result set size

---

## Comparison to Traditional Tools

### IntelliJ "Find Usages" on Spring Framework

**Query**: "Find usages of @RequestMapping"

- Returns: **2000+ results**
- Time to filter: **30-60 minutes** (manual)
- Limitations:
  - No semantic understanding (just text search)
  - No module-level aggregation
  - No context budget (all or nothing)

### MCP on Spring Framework

**Query**: "How is @RequestMapping processed?"

- Returns: **5-10 relevant classes** (with context budget)
- Time to answer: **< 10 seconds**
- Advantages:
  - Semantic search (finds "processing" not just "usage")
  - Module-level summary → Class-level detail
  - Token budget prevents LLM overload

**Time Saved**: **95%+**

---

## Implications for Enterprise Codebases

If MCP works well on Spring Framework (80k entries), it should handle:

- **Microservice architectures** - 50+ services, each 10k-50k entries
- **Monorepos** - 100k-500k entries across multiple projects
- **Legacy refactoring** - Understanding 15-year-old codebases

The key is that **module-level staging + context budgeting** prevent information overload regardless of scale.

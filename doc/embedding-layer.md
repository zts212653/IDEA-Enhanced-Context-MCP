**超级好的问题！** 这正是大规模代码索引的核心挑战。让我给你一个完整的分层索引策略。

## 🎯 核心答案：多层索引 + 智能过滤

**不是非此即彼，而是分层构建！**

---

## 📊 推荐的索引架构

### **三层索引结构**

```
Level 1: Repository Index (仓库级)
├── 元数据：repo名称、描述、主要技术栈
├── 用途：仓库发现、跨仓库搜索
└── 存储量：很小（每个repo只有1条记录）

Level 2: Module Index (模块级)
├── 元数据：模块名、依赖、功能描述
├── 用途：模块内搜索、依赖分析
└── 存储量：中等（每个模块1条记录）

Level 3: Code Index (代码级)
├── 类、方法、字段的详细信息
├── 用途：精确代码搜索
└── 存储量：大（每个类/方法都有记录）
```

---

## 🗂️ 具体设计方案

### **方案：分Collection + 元数据过滤**

在Milvus中创建**一个Collection，但用元数据分层**：

```python
from pymilvus import FieldSchema, CollectionSchema, DataType, Collection

# 统一的Schema，但包含层级信息
fields = [
    FieldSchema(name="id", dtype=DataType.INT64, is_primary=True, auto_id=True),
    
    # 层级标识
    FieldSchema(name="index_level", dtype=DataType.VARCHAR, max_length=20),
    # 可选值: "repository", "module", "class", "method"
    
    # 仓库信息
    FieldSchema(name="repo_name", dtype=DataType.VARCHAR, max_length=200),
    FieldSchema(name="repo_url", dtype=DataType.VARCHAR, max_length=500),
    
    # 模块信息
    FieldSchema(name="module_name", dtype=DataType.VARCHAR, max_length=200),
    FieldSchema(name="module_path", dtype=DataType.VARCHAR, max_length=500),
    # 例如: "user-service", "order-service/order-api"
    
    # 包信息
    FieldSchema(name="package", dtype=DataType.VARCHAR, max_length=500),
    # 例如: "com.company.user.service"
    
    # 代码信息
    FieldSchema(name="fqn", dtype=DataType.VARCHAR, max_length=1000),
    FieldSchema(name="simple_name", dtype=DataType.VARCHAR, max_length=200),
    FieldSchema(name="code_text", dtype=DataType.VARCHAR, max_length=10000),
    
    # 向量
    FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=768),
    
    # 其他元数据...
]

schema = CollectionSchema(fields, description="Multi-level code index")
collection = Collection("java_code_multilevel", schema)
```

---

## 🔍 查询策略：渐进式搜索

### **场景1：用户明确知道范围**

```python
# 用户问："在user-service模块中，找到所有处理分页的方法"

# 查询时加过滤条件
search_params = {
    "metric_type": "IP",
    "params": {"nprobe": 10}
}

# 关键：使用filter表达式限定范围
results = collection.search(
    data=[query_embedding],
    anns_field="embedding",
    param=search_params,
    limit=10,
    expr='module_name == "user-service" and index_level == "method"',
    # ☝️ 只搜索user-service模块的方法级别代码
    output_fields=["fqn", "code_text", "module_name"]
)
```

**效果**：
- ✅ 只在user-service模块内搜索
- ✅ 只返回方法级别的结果
- ✅ 避免其他9999个仓库的干扰

---

### **场景2：用户不确定范围（智能缩小）**

```python
# 用户问："哪里有UserService的实现？"

# Step 1: 先在module级别粗搜
module_results = collection.search(
    data=[query_embedding],
    anns_field="embedding",
    param=search_params,
    limit=5,
    expr='index_level == "module"',  # 只搜模块级
    output_fields=["module_name", "repo_name"]
)

# 找到相关模块：["user-service", "admin-service"]

# Step 2: 在找到的模块内精搜
relevant_modules = [hit.entity.get('module_name') for hit in module_results[0]]
module_filter = " or ".join([f'module_name == "{m}"' for m in relevant_modules])

class_results = collection.search(
    data=[query_embedding],
    anns_field="embedding",
    param=search_params,
    limit=10,
    expr=f'({module_filter}) and index_level == "class"',
    output_fields=["fqn", "code_text"]
)
```

**效果**：
- ✅ 先找到可能相关的2-3个模块
- ✅ 再在这些模块内精确搜索
- ✅ 避免在所有10000个仓库里搜

---

### **场景3：跨模块依赖分析**

```python
# 用户问："哪些模块依赖了user-service？"

# 直接查询依赖关系（来自IDEA Bridge的元数据）
results = collection.query(
    expr='index_level == "module" and "user-service" in dependencies',
    output_fields=["module_name", "repo_name", "dependencies"]
)

# 返回：
# [
#   {"module_name": "order-service", "dependencies": ["user-service", "payment-service"]},
#   {"module_name": "admin-service", "dependencies": ["user-service"]}
# ]
```

---

## 💾 存储数据示例

### **Level 1: Repository级别**

```json
{
  "id": 1,
  "index_level": "repository",
  "repo_name": "microservices-platform",
  "repo_url": "https://git.company.com/microservices-platform",
  "fqn": "microservices-platform",
  "code_text": "Microservices platform with user, order, and payment services. Built with Spring Boot 3.2, using Spring Cloud for service discovery.",
  "embedding": [...],
  "metadata": {
    "tech_stack": ["Java 17", "Spring Boot 3.2", "MySQL", "Redis"],
    "modules": ["user-service", "order-service", "payment-service"],
    "total_classes": 856,
    "total_lines": 45000
  }
}
```

### **Level 2: Module级别**

```json
{
  "id": 2,
  "index_level": "module",
  "repo_name": "microservices-platform",
  "module_name": "user-service",
  "module_path": "services/user-service",
  "package": "com.company.user",
  "fqn": "microservices-platform:user-service",
  "code_text": "User service module. Handles user authentication, authorization, and profile management. Exposes REST API for user operations. Uses Spring Data JPA with MySQL.",
  "embedding": [...],
  "metadata": {
    "dependencies": ["common-lib", "security-lib"],
    "dependents": ["order-service", "admin-service"],
    "classes": 42,
    "apis": ["POST /users", "GET /users/{id}", "PUT /users/{id}"],
    "database": "users_db"
  }
}
```

### **Level 3: Class级别**

```json
{
  "id": 100,
  "index_level": "class",
  "repo_name": "microservices-platform",
  "module_name": "user-service",
  "package": "com.company.user.service",
  "fqn": "com.company.user.service.UserServiceImpl",
  "simple_name": "UserServiceImpl",
  "code_text": "public class UserServiceImpl implements UserService { ... }",
  "embedding": [...],
  "metadata": {
    "implements": ["UserService"],
    "methods": ["findById", "findAll", "save", "delete"],
    "references_count": 15,
    "called_by": ["UserController", "AdminService"]
  }
}
```

### **Level 4: Method级别**

```json
{
  "id": 1001,
  "index_level": "method",
  "repo_name": "microservices-platform",
  "module_name": "user-service",
  "package": "com.company.user.service",
  "fqn": "com.company.user.service.UserServiceImpl#findById",
  "simple_name": "findById",
  "code_text": "public User findById(Long id) { return userRepository.findById(id).orElse(null); }",
  "embedding": [...],
  "metadata": {
    "class_fqn": "com.company.user.service.UserServiceImpl",
    "parameters": [{"name": "id", "type": "Long"}],
    "return_type": "User",
    "calls": ["UserRepository.findById"]
  }
}
```

---

## 🎛️ 上下文控制策略

### **策略1：动态Top-K**

```python
def smart_search(query, user_context=None):
    """根据查询复杂度动态调整返回数量"""
    
    # 分析查询意图
    if is_simple_query(query):  # "UserService在哪"
        top_k = 5
        levels = ["class"]
    elif is_complex_query(query):  # "分析用户服务的完整调用链"
        top_k = 50
        levels = ["class", "method"]
    else:
        top_k = 10
        levels = ["class"]
    
    # 如果用户指定了范围
    filter_expr = ""
    if user_context and user_context.get('module'):
        filter_expr = f'module_name == "{user_context["module"]}"'
    
    # 构建level过滤
    level_filter = " or ".join([f'index_level == "{level}"' for level in levels])
    if filter_expr:
        filter_expr = f'({filter_expr}) and ({level_filter})'
    else:
        filter_expr = level_filter
    
    return collection.search(
        data=[embed(query)],
        anns_field="embedding",
        expr=filter_expr,
        limit=top_k,
        output_fields=["fqn", "code_text", "module_name", "index_level"]
    )
```

---

### **策略2：分阶段返回**

```python
def staged_search(query):
    """分阶段返回结果，避免一次性返回太多"""
    
    # Stage 1: 找到相关模块（不消耗太多token）
    modules = collection.search(
        data=[embed(query)],
        expr='index_level == "module"',
        limit=3,  # 只返回3个最相关模块
        output_fields=["module_name", "code_text"]
    )
    
    print(f"找到相关模块：{[m.entity.get('module_name') for m in modules[0]]}")
    
    # 用户可以选择：
    # 1. "继续在user-service中搜索"
    # 2. "展开所有模块"
    # 3. "只看user-service的概览"
    
    user_choice = input("选择模块继续搜索：")
    
    # Stage 2: 在选定模块内精确搜索
    if user_choice:
        detailed_results = collection.search(
            data=[embed(query)],
            expr=f'module_name == "{user_choice}" and index_level == "class"',
            limit=10,
            output_fields=["fqn", "code_text"]
        )
        return detailed_results
```

---

### **策略3：上下文预算管理**

```python
class ContextBudgetManager:
    """管理返回给LLM的token预算"""
    
    def __init__(self, max_tokens=8000):
        self.max_tokens = max_tokens
        self.used_tokens = 0
    
    def add_result(self, result):
        """智能添加结果，不超预算"""
        
        # 估算token数（1 token ≈ 4 chars for code）
        estimated_tokens = len(result['code_text']) // 4
        
        if self.used_tokens + estimated_tokens > self.max_tokens:
            # 超预算了，返回摘要而不是全部代码
            return {
                "fqn": result['fqn'],
                "summary": self.generate_summary(result),
                "full_code": None  # 不返回完整代码
            }
        else:
            self.used_tokens += estimated_tokens
            return result
    
    def generate_summary(self, result):
        """生成代码摘要"""
        return f"{result['fqn']}: {result['metadata']['description']}"

# 使用
budget = ContextBudgetManager(max_tokens=8000)
filtered_results = [budget.add_result(r) for r in search_results]
```

目前 MCP 工具 `search_java_symbol` 已经按这套策略返回 `contextBudget` 字段（`maxTokens / usedTokens / truncated`），并在 `debug.strategy` 中描述本次动态 Top-K 计划（包含模块/类/方法 limit、是否启用 module hint 等）。也就是说，调用方不需要重新估算 token，直接读取返回体即可知道还有多少预算可以继续添加上下文。

---

## 📈 存储量对比

假设你们有：
- 10,000个仓库
- 每个仓库平均10个模块
- 每个模块平均100个类
- 每个类平均5个方法

| Level | 记录数 | 每条大小 | 总存储 |
|-------|--------|---------|--------|
| Repository | 10,000 | ~1KB | 10MB |
| Module | 100,000 | ~2KB | 200MB |
| Class | 10,000,000 | ~5KB | 50GB |
| Method | 50,000,000 | ~2KB | 100GB |
| **总计** | **60,100,000** | - | **~150GB** |

**但实际查询时**：
```
用户查询 → 只搜1-2个模块 → 只有1000-2000条记录参与
检索到 → 10个相关类 → 返回给LLM
Token消耗 → 约5000-8000 tokens
```

---

## 实际 Milvus Schema（当前实现）

- Collection: `idea_symbols`
- Key fields: `id` (primary key), `index_level`, `repo_name`, `module_name`, `module_path`, `package_name`, `symbol_name`, `fqn`, `summary`, `metadata`, plus vector field `embedding`.
- Metadata JSON中包含 `dependencies`, `spring`, `relations`, `quality`, `uploadMeta`（schema version / project / timestamps）。
- 脚本：`npm run inspect-schema` 可打印当前集合字段与索引，并在 MCP 启动时通过 `ensureCollectionExists()` 自动校验。

## 🎯 推荐实施方案

### **Phase 1：MVP（现在）**

```python
# 简化版：只有两层
LEVELS = ["module", "class"]

# 每个Java类存一条记录，包含module信息
{
  "index_level": "class",
  "module_name": "user-service",  # 关键过滤字段
  "fqn": "com.company.user.service.UserServiceImpl",
  "code_text": "...",
  "embedding": [...]
}

# 查询时过滤
expr = 'module_name == "user-service"'
```

**优点**：
- ✅ 实现简单
- ✅ 已经能解决90%的范围问题
- ✅ 数据结构扁平

---

### **Phase 2：优化（M2）**

加入method级别：
```python
LEVELS = ["module", "class", "method"]

# 大方法单独索引
if method.line_count > 50:
    index_method_separately(method)
```

---

### **Phase 3：完整版（M3）**

加入repository级别和智能上下文管理：
```python
LEVELS = ["repository", "module", "class", "method"]

# 完整的分层搜索和预算管理
```

---

## 💡 关键设计原则

### **1. 元数据优先**

不要把所有代码都塞到embedding里，而是：
```python
# ❌ 错误做法
embedding = embed(entire_class_code)  # 5000行代码全embedding

# ✅ 正确做法
metadata = extract_from_idea(class)  # IDEA提供的结构化信息
summary = generate_smart_summary(metadata)
embedding = embed(summary)  # 只embed智能摘要

# 原始代码存在code_text字段，但不用于embedding
```

### **2. 渐进式披露**

```
查询 → 先返回module列表（轻量）
     → 用户选择module
     → 再返回class列表（中量）
     → 用户选择class
     → 返回完整代码（重量）
```

### **3. 智能预加载**

```python
# 对于常访问的模块，预加载摘要
if module in HOT_MODULES:
    preload_summaries(module)
```

---

## ✅ 最终建议

对于你们上万仓库的规模：

**必须做**：
1. ✅ 元数据中包含 `module_name` 字段
2. ✅ 查询时用 `expr` 过滤模块范围
3. ✅ 限制 `top_k`（通常10-20足够）

**建议做**：
1. ✅ 分层索引（至少module + class两层）
2. ✅ 上下文预算管理
3. ✅ 智能摘要（而不是返回完整代码）

**可选做**：
1. 多个Collection（按仓库分）
2. 缓存热点查询
3. 实时增量更新

**核心思想**：
- 索引可以很大（150GB没问题）
- 但查询一定要精准过滤
- 返回结果必须有限（10-20条）
- Token预算严格控制（<10K）

需要我给你写一个完整的代码示例，展示如何实现这个分层索引 + 智能过滤的系统吗？

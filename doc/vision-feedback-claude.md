# IDEA-Enhanced-Context 架构反馈与演进建议

> 基于愿景文档的深度分析与工程化落地方案
> 
> 反馈日期：2025-12

---

## 一、核心判断：你们的方向完全正确

### 1.1 为什么 LLM 在 Spring 生态中"不敢改"

这不是 LLM 能力问题，而是**信息论上的结构性缺失**：

| LLM 能看到的 | LLM 看不到的 |
|-------------|-------------|
| 代码文本 | IoC 容器运行时 Bean 装配 |
| 方法签名 | AOP 代理的实际拦截点 |
| 注解声明 | @Conditional 条件评估结果 |
| import 语句 | spring.factories / SPI 动态加载 |
| 显式调用 | 反射调用、事件监听 |

**你们要做的本质：把 Spring 的"黑魔法运行时"翻译成 LLM 可消费的结构化证据。**

这比"更聪明的 RAG"有价值得多。

### 1.2 你们的核心优势

```
PSI 静态分析 >> LLM 文本抽取
```

学术界的 Graph RAG 效果差，是因为用 LLM 从文本抽取实体/关系，噪声巨大。而你们有 **IDE 级别的 PSI 解析**，边是确定的、可验证的。

**这是工业级优势，要放大它，而不是去追学术概念。**

---

## 二、架构建议：不引入新数据库

### 2.1 关键决策：用 Milvus Collection 存边表，不引入 Postgres

你们已有 Milvus，它完全支持：
- 纯元数据存储（不必有向量）
- 结构化字段过滤
- 标量索引加速查询

**边表用 Milvus 新 Collection 实现，零额外运维成本。**

### 2.2 整体架构（演进后）

```
┌─────────────────────────────────────────────────────────────────────┐
│                         LLM (Claude/GPT)                            │
│                    "修改这个方法安全吗？"                              │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          MCP Tools Layer                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │ search_symbol   │  │ analyze_impact  │  │ explain_behavior    │  │
│  │ (向量+精确匹配)  │  │ (边表遍历)      │  │ (符号卡片解读)       │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
┌───────────────────────────────┐  ┌───────────────────────────────────┐
│   Milvus: idea_symbols_*      │  │   Milvus: idea_edges              │
│   (符号卡片 + 向量)            │  │   (边表，纯元数据，无向量)          │
│                               │  │                                   │
│  - FQN, signature, annotations│  │  - src_fqn → dst_fqn              │
│  - springInfo, roles          │  │  - edge_type (CALL/AOP/SPI/...)   │
│  - module, callers, callees   │  │  - evidence, weight, version      │
│  - embeddingText (DSL v2)     │  │                                   │
│  - vector (1024d)             │  │                                   │
└───────────────────────────────┘  └───────────────────────────────────┘
                    │                           │
                    └─────────────┬─────────────┘
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PSI Export + Ingest Pipeline                     │
│                                                                     │
│  IDEA Plugin → JSON Export → Ingest → Milvus Collections           │
│                                                                     │
│  新增：边提取器 (显式调用 + 隐式链路解析)                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、Milvus 边表设计（idea_edges Collection）

### 3.1 Schema 定义

```python
from pymilvus import CollectionSchema, FieldSchema, DataType

fields = [
    # 主键
    FieldSchema(name="id", dtype=DataType.VARCHAR, max_length=256, is_primary=True),
    
    # 边的两端
    FieldSchema(name="src_fqn", dtype=DataType.VARCHAR, max_length=512),
    FieldSchema(name="dst_fqn", dtype=DataType.VARCHAR, max_length=512),
    
    # 边类型：CALL, REF, AOP, BPP, SPI, IMPORT, EVENT, COND, REFLECTION
    FieldSchema(name="edge_type", dtype=DataType.VARCHAR, max_length=32),
    
    # 证据来源
    FieldSchema(name="evidence_source", dtype=DataType.VARCHAR, max_length=128),
    # 可选：psi.calls, psi.references, spring.factories, @Import, pointcut, @EventListener...
    
    # 证据片段（可选，用于解释）
    FieldSchema(name="evidence_snippet", dtype=DataType.VARCHAR, max_length=512),
    
    # 位置信息
    FieldSchema(name="file_path", dtype=DataType.VARCHAR, max_length=256),
    FieldSchema(name="line_number", dtype=DataType.INT64),
    
    # 模块信息
    FieldSchema(name="src_module", dtype=DataType.VARCHAR, max_length=128),
    FieldSchema(name="dst_module", dtype=DataType.VARCHAR, max_length=128),
    
    # 权重与版本
    FieldSchema(name="weight", dtype=DataType.FLOAT),
    FieldSchema(name="version", dtype=DataType.VARCHAR, max_length=64),
    
    # 是否为测试代码
    FieldSchema(name="is_test", dtype=DataType.BOOL),
]

schema = CollectionSchema(fields, description="Code dependency edges")

# 创建索引（标量索引，加速过滤查询）
# 对 src_fqn, dst_fqn, edge_type 建索引
```

### 3.2 边类型定义

| edge_type | 来源 | 说明 | 优先级 |
|-----------|------|------|--------|
| `CALL` | PSI 调用分析 | 显式方法调用 | P0 |
| `REF` | PSI 引用分析 | 类型引用、字段访问 | P0 |
| `AOP` | @Aspect + pointcut 解析 | Advice → JoinPoint | P1 |
| `BPP` | BeanPostProcessor 识别 | BPP → 可能影响的 Bean | P1 |
| `SPI` | spring.factories 解析 | AutoConfiguration 加载链 | P1 |
| `IMPORT` | @Import/@Enable* 解析 | ImportSelector/Registrar | P1 |
| `EVENT` | @EventListener 解析 | 事件发布 → 监听器 | P1 |
| `COND` | @Conditional* 解析 | 条件化装配依赖 | P2 |
| `REFLECTION` | 反射模式识别 | Class.forName / getMethod | P2 |

### 3.3 查询示例

```python
# 查询直接调用方（1-hop callers）
results = collection.query(
    expr='dst_fqn == "com.example.UserService#createUser" and is_test == false',
    output_fields=["src_fqn", "edge_type", "src_module", "evidence_source"]
)

# 查询所有隐式依赖方
results = collection.query(
    expr='dst_fqn == "com.example.UserService#createUser" and edge_type in ["AOP", "BPP", "SPI", "EVENT"]',
    output_fields=["src_fqn", "edge_type", "evidence_snippet"]
)

# 2-hop 查询：先查直接调用方，再查调用方的调用方
direct_callers = [r["src_fqn"] for r in results]
# 构造 IN 查询...
```

---

## 四、embeddingText DSL 协议 v2

### 4.1 设计原则

1. **固定字段顺序**：保证不同实现者输出一致
2. **语义优先**：用自然语言模板，不是 JSON
3. **预算控制**：总长度限制，超出则按优先级裁剪
4. **噪声过滤**：getter/setter 降权、路径噪声去除

### 4.2 Class 级别模板

```
[Class] {fqn}
[Module] {module}
[Package] {package}
[Type] {classType} // class, interface, enum, annotation
[Roles] {roles} // @Service, @Repository, @Controller, @Configuration, Spring Bean, ...
[Extends] {superClass}
[Implements] {interfaces}
[Annotations] {annotations} // 非 Spring 的其他注解
[Spring] {springInfo} // Bean scope, conditional, profiles
[Infra] {infraTags} // DB:xxx, MQ:xxx, HTTP:xxx
[Key Methods] {methodSummaries} // 公共方法签名，限 10 个，排除 getter/setter
[Callers Count] {callersCount} from {callerModules}
[Callees Count] {calleesCount} to {calleeModules}
```

### 4.3 Method 级别模板

```
[Method] {classFqn}#{methodName}
[Module] {module}
[Signature] {returnType} {methodName}({params})
[Visibility] {visibility}
[Annotations] {annotations}
[Spring] {springInfo} // @Transactional, @Async, @Cacheable, @Scheduled...
[Infra] {infraTags}
[Calls] {calleesList} // 限 5 个最重要的
[Called By] {callersList} // 限 5 个最重要的
[Implicit Deps] {implicitDeps} // AOP, Event, SPI 依赖
```

### 4.4 裁剪规则

```python
MAX_EMBEDDING_TEXT_LENGTH = 2000  # 字符

FIELD_PRIORITY = [
    "fqn",           # 必须
    "module",        # 必须
    "signature",     # 必须
    "roles",         # 高优
    "annotations",   # 高优
    "springInfo",    # 高优
    "infraTags",     # 高优
    "extends",       # 中优
    "implements",    # 中优
    "callers",       # 中优，限数量
    "callees",       # 中优，限数量
    "keyMethods",    # 低优，限数量
]

def render_embedding_text(symbol: dict) -> str:
    """按优先级渲染，超出预算则裁剪低优先级字段"""
    text = ""
    for field in FIELD_PRIORITY:
        field_text = render_field(symbol, field)
        if len(text) + len(field_text) > MAX_EMBEDDING_TEXT_LENGTH:
            break
        text += field_text
    return text
```

### 4.5 Getter/Setter 处理

```python
def is_getter_setter(method_name: str, params: list) -> bool:
    if method_name.startswith("get") and len(params) == 0:
        return True
    if method_name.startswith("set") and len(params) == 1:
        return True
    if method_name.startswith("is") and len(params) == 0:
        return True
    return False

# 在 keyMethods 里排除 getter/setter
# 在 callers/callees 统计里降权 getter/setter
```

---

## 五、影响面分析工具增强

### 5.1 analyze_impact 标准输出格式

```yaml
impact_analysis:
  target: "com.example.UserService#createUser"
  timestamp: "2025-12-16T10:30:00Z"
  version: "abc123"  # git sha
  
  # 置信度评估
  confidence: 0.78
  confidence_factors:
    evidence_coverage: 0.85
    module_coverage: 0.90
    implicit_link_coverage: 0.60
  
  # 风险等级
  risk_level: MEDIUM  # LOW / MEDIUM / HIGH / CRITICAL
  
  # 直接影响
  direct_impact:
    callers:
      total: 12
      non_test: 8
      cross_module: 2
      examples:
        - fqn: "com.example.UserController#register"
          module: "user-api"
          edge_type: "CALL"
        - fqn: "com.example.BatchUserImporter#importUsers"
          module: "batch-service"
          edge_type: "CALL"
    callees:
      total: 5
      examples:
        - fqn: "com.example.UserRepository#save"
          module: "user-core"
          edge_type: "CALL"
  
  # 隐式影响（关键！）
  implicit_impact:
    aop:
      count: 2
      examples:
        - advice: "com.example.TransactionAspect#around"
          pointcut: "@Transactional"
        - advice: "com.example.AuditAspect#afterReturning"
          pointcut: "execution(* com.example..*Service.*(..))"
    events:
      count: 1
      examples:
        - event: "UserCreatedEvent"
          listeners:
            - "com.example.NotificationListener#onUserCreated"
            - "com.example.AuditListener#onUserCreated"
    spi:
      count: 0
      examples: []
  
  # 外部系统触达
  external_systems:
    database:
      - table: "users"
        operation: "INSERT"
      - table: "audit_log"
        operation: "INSERT"
    message_queue:
      - topic: "user-created-topic"
        operation: "PUBLISH"
    http:
      - endpoint: "/api/users"
        method: "POST"
  
  # 模块分布
  module_distribution:
    - module: "user-core"
      caller_count: 5
      callee_count: 3
    - module: "user-api"
      caller_count: 2
      callee_count: 0
    - module: "batch-service"
      caller_count: 1
      callee_count: 0
  
  # 覆盖缺口（关键！用于解释置信度）
  coverage_gaps:
    - type: "REFLECTION"
      description: "检测到 2 处反射调用，目标无法静态确定"
      locations:
        - "com.example.PluginLoader:45"
    - type: "CONDITIONAL"
      description: "@ConditionalOnProperty 未评估，依赖运行时配置"
      conditions:
        - "user.feature.enabled"
    - type: "SPI"
      description: "spring.factories 未完全解析"
  
  # 风险因素（人类可读）
  risk_factors:
    - "跨模块调用：batch-service 依赖此方法"
    - "事件监听器可能受影响：NotificationListener, AuditListener"
    - "存在 2 处 AOP 拦截"
    - "写入外部系统：users 表, user-created-topic"
  
  # 建议
  recommendations:
    - "建议通知 batch-service 模块 owner"
    - "验证 NotificationListener 的兼容性"
    - "检查 AuditAspect 是否依赖方法签名"
```

### 5.2 置信度计算实现

```python
import math

def compute_confidence(
    edges: list,
    module_coverage: float,  # 0~1，有 module 信息的边占比
    gaps: list  # coverage_gaps
) -> tuple[float, dict]:
    """
    计算影响面分析的置信度
    
    Returns:
        (confidence, factors)
    """
    base = 0.55
    factors = {}
    
    # === 加分项 ===
    
    # 模块信息完整度
    if module_coverage > 0.8:
        base += 0.10
        factors["module_coverage"] = "+0.10"
    elif module_coverage > 0.5:
        base += 0.05
        factors["module_coverage"] = "+0.05"
    
    # 显式调用边数量（对数衰减）
    call_count = count_edges_by_type(edges, "CALL")
    call_bonus = 0.05 * math.log1p(call_count)
    base += call_bonus
    factors["call_edges"] = f"+{call_bonus:.3f} ({call_count} edges)"
    
    # 引用边数量
    ref_count = count_edges_by_type(edges, "REF")
    ref_bonus = 0.03 * math.log1p(ref_count)
    base += ref_bonus
    factors["ref_edges"] = f"+{ref_bonus:.3f} ({ref_count} edges)"
    
    # 结构化隐式边（这些是"好的"隐式链路，已被解析）
    implicit_types = ["AOP", "BPP", "SPI", "IMPORT", "EVENT"]
    implicit_count = sum(count_edges_by_type(edges, t) for t in implicit_types)
    implicit_bonus = 0.04 * math.log1p(implicit_count)
    base += implicit_bonus
    factors["implicit_edges"] = f"+{implicit_bonus:.3f} ({implicit_count} edges)"
    
    # === 减分项 ===
    
    # 未解析的反射调用
    if has_gap(gaps, "REFLECTION"):
        base -= 0.15
        factors["reflection_gap"] = "-0.15"
    
    # 未评估的条件化配置
    if has_gap(gaps, "CONDITIONAL"):
        base -= 0.10
        factors["conditional_gap"] = "-0.10"
    
    # 未解析的 SPI
    if has_gap(gaps, "SPI"):
        base -= 0.05
        factors["spi_gap"] = "-0.05"
    
    # 模块信息严重缺失
    if module_coverage < 0.3:
        base -= 0.05
        factors["module_missing"] = "-0.05"
    
    # Clamp to [0, 1]
    confidence = max(0.0, min(1.0, base))
    
    return confidence, factors


def compute_risk_level(
    confidence: float,
    cross_module_callers: int,
    external_systems: dict,
    implicit_impact: dict
) -> str:
    """
    基于置信度和影响范围计算风险等级
    """
    score = 0
    
    # 置信度低 = 风险高（因为不确定性大）
    if confidence < 0.5:
        score += 3
    elif confidence < 0.7:
        score += 1
    
    # 跨模块调用
    if cross_module_callers > 5:
        score += 3
    elif cross_module_callers > 2:
        score += 2
    elif cross_module_callers > 0:
        score += 1
    
    # 外部系统触达
    if external_systems.get("database"):
        score += 1
    if external_systems.get("message_queue"):
        score += 2  # MQ 影响面更难追踪
    if external_systems.get("http"):
        score += 1
    
    # 隐式影响
    if implicit_impact.get("aop", {}).get("count", 0) > 0:
        score += 1
    if implicit_impact.get("events", {}).get("count", 0) > 0:
        score += 2  # 事件影响面难追踪
    
    # 映射到风险等级
    if score >= 8:
        return "CRITICAL"
    elif score >= 5:
        return "HIGH"
    elif score >= 2:
        return "MEDIUM"
    else:
        return "LOW"
```

---

## 六、轻量精确匹配 Boost（不引入 BM25）

### 6.1 Query 分析与 Token 提取

```python
import re

def extract_query_tokens(query: str) -> dict:
    """
    从用户查询中提取可用于精确匹配的 token
    """
    tokens = {
        "fqn": None,
        "class_name": None,
        "method_name": None,
        "package_prefix": None,
        "annotations": [],
        "keywords": []
    }
    
    # 检测完整 FQN（如 com.example.UserService#createUser）
    fqn_pattern = r'([a-z][a-z0-9]*\.)+[A-Z][a-zA-Z0-9]*#[a-z][a-zA-Z0-9]*'
    fqn_match = re.search(fqn_pattern, query)
    if fqn_match:
        tokens["fqn"] = fqn_match.group()
        return tokens  # 有完整 FQN，直接精确匹配
    
    # 检测类名（大驼峰）
    class_pattern = r'\b([A-Z][a-zA-Z0-9]*(?:Service|Controller|Repository|Handler|Listener|Aspect|Config|Factory))\b'
    class_matches = re.findall(class_pattern, query)
    if class_matches:
        tokens["class_name"] = class_matches[0]
    
    # 检测方法名（小驼峰）
    method_pattern = r'\b([a-z][a-zA-Z0-9]*(?:User|Order|Payment|Account|Data|Event|Message)?)\b'
    # 这个需要更精细的规则，简化处理
    
    # 检测注解
    annotation_pattern = r'@([A-Z][a-zA-Z0-9]*)'
    tokens["annotations"] = re.findall(annotation_pattern, query)
    
    # 检测包名前缀
    package_pattern = r'\b(com\.[a-z]+(?:\.[a-z]+)*)\b'
    pkg_match = re.search(package_pattern, query)
    if pkg_match:
        tokens["package_prefix"] = pkg_match.group()
    
    return tokens


def apply_token_boost(results: list, tokens: dict) -> list:
    """
    对向量检索结果应用 token boost
    """
    for result in results:
        boost = 0.0
        
        # FQN 完全匹配：直接置顶
        if tokens["fqn"] and result["fqn"] == tokens["fqn"]:
            boost += 100.0
        
        # 类名匹配
        if tokens["class_name"] and tokens["class_name"] in result["fqn"]:
            boost += 5.0
        
        # 方法名匹配
        if tokens["method_name"] and f"#{tokens['method_name']}" in result["fqn"]:
            boost += 3.0
        
        # 包名前缀匹配
        if tokens["package_prefix"] and result["fqn"].startswith(tokens["package_prefix"]):
            boost += 2.0
        
        # 注解匹配
        for ann in tokens["annotations"]:
            if ann in result.get("annotations", []):
                boost += 1.5
        
        # Getter/Setter 惩罚
        method_name = result["fqn"].split("#")[-1] if "#" in result["fqn"] else ""
        if is_getter_setter(method_name):
            boost -= 3.0
        
        # Test 类惩罚
        if "Test" in result["fqn"] or "test" in result.get("module", ""):
            boost -= 2.0
        
        result["_boost"] = boost
        result["_final_score"] = result["_score"] + boost
    
    # 按 final_score 重排序
    results.sort(key=lambda x: x["_final_score"], reverse=True)
    return results
```

### 6.2 检索流程

```python
async def search_symbol(query: str, top_k: int = 20) -> list:
    """
    混合检索：向量 + 精确匹配 boost
    """
    tokens = extract_query_tokens(query)
    
    # 如果有完整 FQN，直接精确查询
    if tokens["fqn"]:
        exact_result = await exact_lookup(tokens["fqn"])
        if exact_result:
            return [exact_result]
    
    # 向量检索
    query_vector = await embed(query)
    results = await milvus_search(
        collection="idea_symbols_spring_jina",
        vector=query_vector,
        top_k=top_k * 5,  # 多召回一些，后面 boost 重排
        output_fields=["fqn", "module", "annotations", "roles", "springInfo"]
    )
    
    # 应用 token boost
    results = apply_token_boost(results, tokens)
    
    # 可选：Rerank
    if RERANK_ENABLED:
        results = await rerank(query, results[:100])
    
    return results[:top_k]
```

---

## 七、隐式链路解析器设计

### 7.1 解析器接口

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

@dataclass
class Edge:
    src_fqn: str
    dst_fqn: str
    edge_type: str
    evidence_source: str
    evidence_snippet: str = ""
    file_path: str = ""
    line_number: int = 0
    src_module: str = ""
    dst_module: str = ""
    weight: float = 1.0

class ImplicitLinkParser(ABC):
    @abstractmethod
    def parse(self, project_data: dict) -> list[Edge]:
        """解析项目数据，返回边列表"""
        pass

class AopParser(ImplicitLinkParser):
    """解析 @Aspect + @Around/@Before/@After → JoinPoint"""
    
    def parse(self, project_data: dict) -> list[Edge]:
        edges = []
        for cls in project_data["classes"]:
            if "@Aspect" not in cls.get("annotations", []):
                continue
            
            for method in cls.get("methods", []):
                pointcut = self._extract_pointcut(method)
                if not pointcut:
                    continue
                
                # 找到所有匹配 pointcut 的目标
                targets = self._match_pointcut(pointcut, project_data)
                for target in targets:
                    edges.append(Edge(
                        src_fqn=f"{cls['fqn']}#{method['name']}",
                        dst_fqn=target,
                        edge_type="AOP",
                        evidence_source="@Aspect",
                        evidence_snippet=f"pointcut: {pointcut}",
                        file_path=cls.get("file", ""),
                        line_number=method.get("line", 0)
                    ))
        return edges


class SpringFactoriesParser(ImplicitLinkParser):
    """解析 META-INF/spring.factories"""
    
    def parse(self, project_data: dict) -> list[Edge]:
        edges = []
        factories_files = project_data.get("spring_factories", [])
        
        for factory in factories_files:
            for key, values in factory.get("entries", {}).items():
                # key: EnableAutoConfiguration
                # values: [com.example.MyAutoConfiguration, ...]
                for value in values:
                    edges.append(Edge(
                        src_fqn=key,
                        dst_fqn=value,
                        edge_type="SPI",
                        evidence_source="spring.factories",
                        evidence_snippet=f"{key}={value}",
                        file_path=factory.get("file", "")
                    ))
        return edges


class ImportSelectorParser(ImplicitLinkParser):
    """解析 @Import, @Enable*, ImportSelector, ImportBeanDefinitionRegistrar"""
    
    def parse(self, project_data: dict) -> list[Edge]:
        edges = []
        for cls in project_data["classes"]:
            # @Import 注解
            import_values = self._extract_import_values(cls)
            for imported in import_values:
                edges.append(Edge(
                    src_fqn=cls["fqn"],
                    dst_fqn=imported,
                    edge_type="IMPORT",
                    evidence_source="@Import",
                    evidence_snippet=f"@Import({imported})"
                ))
            
            # @Enable* 注解
            enable_annotations = [a for a in cls.get("annotations", []) if a.startswith("@Enable")]
            for ann in enable_annotations:
                # 需要解析 @Enable* 对应的 @Import
                pass
        
        return edges


class EventListenerParser(ImplicitLinkParser):
    """解析 @EventListener 和 ApplicationEventPublisher"""
    
    def parse(self, project_data: dict) -> list[Edge]:
        edges = []
        
        # 收集所有事件监听器
        listeners = {}  # event_type -> [listener_fqn]
        for cls in project_data["classes"]:
            for method in cls.get("methods", []):
                if "@EventListener" in method.get("annotations", []):
                    event_type = self._extract_event_type(method)
                    if event_type:
                        listeners.setdefault(event_type, []).append(
                            f"{cls['fqn']}#{method['name']}"
                        )
        
        # 找到所有事件发布点
        for cls in project_data["classes"]:
            for method in cls.get("methods", []):
                published_events = self._find_published_events(method)
                for event_type in published_events:
                    for listener in listeners.get(event_type, []):
                        edges.append(Edge(
                            src_fqn=f"{cls['fqn']}#{method['name']}",
                            dst_fqn=listener,
                            edge_type="EVENT",
                            evidence_source="@EventListener",
                            evidence_snippet=f"publishes {event_type}"
                        ))
        
        return edges
```

### 7.2 解析器优先级与实施计划

| 优先级 | 解析器 | 复杂度 | 收益 | 阶段 |
|--------|--------|--------|------|------|
| P0 | CALL/REF（已有） | 低 | 高 | 现有 |
| P1 | AopParser | 中 | 高 | 1 月内 |
| P1 | EventListenerParser | 中 | 高 | 1 月内 |
| P1 | SpringFactoriesParser | 低 | 中 | 1 月内 |
| P1 | ImportSelectorParser | 中 | 中 | 1 月内 |
| P2 | ConditionalParser | 高 | 中 | 2 月内 |
| P2 | ReflectionPatternMatcher | 高 | 中 | 2 月内 |

---

## 八、回归测试增强

### 8.1 Tier 体系扩展

```yaml
tier1_symbol_retrieval:
  description: "基础符号检索质量"
  cases:
    - query: "UserService createUser"
      expected_top1: "com.example.UserService#createUser"
    - query: "@Transactional service"
      expected_contains: ["com.example.UserService", "com.example.OrderService"]
  threshold: 0.9  # 90% cases pass

tier2_spring_features:
  description: "Spring 特性覆盖"
  cases:
    - name: "AOP advice 检索"
      query: "transaction aspect"
      expected_contains: "TransactionAspect"
    - name: "Event listener 检索"
      query: "user created event listener"
      expected_contains: "UserCreatedEventListener"
    - name: "WebFlux handler"
      query: "reactive user handler"
      expected_contains: "ReactiveUserHandler"
  threshold: 0.85

tier3_impact_analysis:
  description: "影响面分析质量"
  cases:
    - name: "直接调用方完整性"
      target: "com.example.UserRepository#save"
      expected_callers_min: 5
      expected_cross_module: true
    - name: "隐式依赖发现"
      target: "com.example.UserService#createUser"
      expected_implicit:
        aop: true
        events: true
  threshold: 0.8

tier4_confidence_accuracy:  # 新增
  description: "置信度准确性"
  cases:
    - name: "高置信度案例"
      target: "com.example.SimpleService#simpleMethod"
      expected_confidence_min: 0.7
      expected_gaps: []
    - name: "低置信度案例（有反射）"
      target: "com.example.PluginLoader#loadPlugin"
      expected_confidence_max: 0.6
      expected_gaps: ["REFLECTION"]
  threshold: 0.75
```

### 8.2 自动化验证脚本

```python
async def run_regression_tests(tier: str) -> dict:
    """运行回归测试"""
    config = load_tier_config(tier)
    results = {"passed": 0, "failed": 0, "cases": []}
    
    for case in config["cases"]:
        if tier.startswith("tier1") or tier.startswith("tier2"):
            # 检索质量测试
            actual = await search_symbol(case["query"])
            passed = evaluate_retrieval(actual, case)
        
        elif tier.startswith("tier3"):
            # 影响面分析测试
            actual = await analyze_impact(case["target"])
            passed = evaluate_impact(actual, case)
        
        elif tier.startswith("tier4"):
            # 置信度测试
            actual = await analyze_impact(case["target"])
            passed = evaluate_confidence(actual, case)
        
        results["cases"].append({
            "name": case.get("name", case.get("query")),
            "passed": passed,
            "actual": actual
        })
        results["passed" if passed else "failed"] += 1
    
    pass_rate = results["passed"] / len(config["cases"])
    results["pass_rate"] = pass_rate
    results["threshold_met"] = pass_rate >= config["threshold"]
    
    return results
```

---

## 九、实施路线图

### Phase 1: 基础增强（1-2 周）

| 任务 | 产出 | 验收标准 |
|------|------|---------|
| embeddingText DSL v2 | 渲染器代码 + 协议文档 | Tier1 通过率 ≥ 90% |
| module 信息补全 | ingest 管道更新 | callers/callees 输出有 module |
| 轻量精确匹配 boost | 检索层代码 | 同名 getter/setter 干扰下降 |
| 边表 Collection 创建 | Milvus schema | idea_edges 可查询 |

### Phase 2: 隐式链路 v1（2-4 周）

| 任务 | 产出 | 验收标准 |
|------|------|---------|
| AopParser | 解析器 + 边数据 | AOP 边可查 |
| EventListenerParser | 解析器 + 边数据 | Event 边可查 |
| SpringFactoriesParser | 解析器 + 边数据 | SPI 边可查 |
| impact_analysis 报告 | 工具输出格式 | Tier3 通过率 ≥ 80% |
| 置信度计算 | 打分函数 | Tier4 通过率 ≥ 75% |

### Phase 3: 模型 A/B（2-4 周，可与 Phase 2 并行）

| 任务 | 产出 | 验收标准 |
|------|------|---------|
| jina-code-1.5b@1024 | 新集合 + 评测 | 对比 Jina v3 基线 |
| Qwen3-Embedding-4B@1024 | 新集合 + 评测 | MRL 输出 1024 维 |
| Qwen3-Reranker-4B | rerank 集成 | TopK=200, rerankK=100 |
| 评测闭环 | 自动化报告 | 可复现的 A/B 结论 |

### Phase 4: 工业级增强（1-2 月）

| 任务 | 产出 | 验收标准 |
|------|------|---------|
| ImportSelectorParser | 解析器 | @Import/@Enable* 覆盖 |
| ConditionalParser | 解析器 | @Conditional 边（标记未评估）|
| ReflectionPatternMatcher | 解析器 | 常见反射模式识别 |
| 影响面摘要生成 | LLM prompt + 模板 | 可用于 PR review |

---

## 十、关键决策总结

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 是否引入图数据库 | **否** | Milvus 边表足够，零额外运维 |
| 是否引入 BM25 | **否（短期）** | 精确匹配 boost 可达 80% 收益 |
| 是否改 schema 维度 | **否（短期）** | 1024 维保持兼容，用 rerank 提升 |
| 隐式链路存哪里 | **边表 + 符号卡片摘要** | 边可查询，摘要可 embed |
| 置信度如何算 | **证据覆盖 + 缺口惩罚** | 可解释、可回归 |

---

## 十一、最终建议

你们的方向完全正确：**把 IDE 的静态分析能力暴露给 LLM，而不是让 LLM 去猜。**

核心差异化优势：
- PSI 级别的符号解析（比 LLM 文本抽取靠谱 100 倍）
- Spring 生态的隐式链路显式化（AOP/SPI/Event/Conditional）
- 结构化的影响面报告（置信度 + 证据 + 缺口）

**不要追学术概念（Graph RAG），要做工程落地。**

用最小的架构变动（Milvus 边表 + DSL 渲染器 + 置信度计算）实现最大的价值提升（从"参考"到"决策依据"）。

---

*报告完*
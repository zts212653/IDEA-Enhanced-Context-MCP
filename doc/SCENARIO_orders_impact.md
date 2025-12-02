# SCENARIO_orders_impact · E-commerce Order Creation Blast Radius

## 1. 场景背景

- 仓库：`company-orders-service`（假设）
- 入口：`com.example.orders.OrderController#createOrder`
- HTTP：`POST /orders`
- 目标：改动下单 handler 语义（校验、幂等、同步/异步）时，快速看清下游影响面：
  - 哪些组件/外部系统会被触达？
  - 哪些表/Mapper 被写？
  - 哪些 MQ 交换机/路由键被发布？
  - 哪些扩展点（PaymentService 多实现）要一并评估？

## 2. 输入代码（摘录）

```java
// Controller 入口
@RestController
@RequestMapping("/orders")
@RequiredArgsConstructor
public class OrderController {
    private final OrderService orderService;

    @PostMapping
    public OrderResponse createOrder(@RequestBody CreateOrderRequest request) {
        return orderService.createOrder(request);
    }
}

// Service：聚合 DB + 支付扩展点 + MQ
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderMapper orderMapper;
    private final PaymentService paymentService;
    private final RabbitTemplate rabbitTemplate;

    @Transactional
    public OrderResponse createOrder(CreateOrderRequest request) {
        Order order = new Order(request.getUserId(), request.getItems());
        orderMapper.insertOrder(order); // DB
        paymentService.charge(order.getId(), request.getPaymentMethod()); // 扩展点
        rabbitTemplate.convertAndSend( // MQ
            "order.exchange",
            "order.created",
            new OrderCreatedEvent(order.getId())
        );
        return new OrderResponse(order.getId(), order.getStatus());
    }
}

// MyBatis Mapper
@Mapper
public interface OrderMapper {
    void insertOrder(Order order);
}

// 支付扩展点（多实现）
public interface PaymentService {
    void charge(Long orderId, PaymentMethod method);
}

@Service
@Qualifier("alipayPaymentService")
public class AlipayPaymentService implements PaymentService {
    @Override
    public void charge(Long orderId, PaymentMethod method) { /* ... */ }
}

@Service
@Qualifier("wechatPaymentService")
public class WechatPaymentService implements PaymentService {
    @Override
    public void charge(Long orderId, PaymentMethod method) { /* ... */ }
}
```

## 3. PSI/Milvus 预计算图（预期形态）

- OrderController：
  - `springInfo.isSpringBean = true`, `beanType = "RestController"`
  - `relations.calls = ["com.example.orders.OrderService#createOrder"]`
  - roles 推断：`["REST_CONTROLLER","SPRING_BEAN"]`
- OrderService：
  - `springInfo.isSpringBean = true`, `beanType = "Service"`
  - `relations.calls` 包含：
    - `com.example.orders.OrderMapper#insertOrder`
    - `com.example.payment.PaymentService#charge`
    - `org.springframework.amqp.rabbit.core.RabbitTemplate#convertAndSend`
  - `dependencies.fieldTypes` 里有 OrderMapper / PaymentService / RabbitTemplate
  - roles：`["SPRING_BEAN"]`（未来可细分 APP_SERVICE）
- OrderMapper：
  - 注解 @Mapper / 包名持久层
  - roles：`["REPOSITORY"]`
- PaymentService 及实现：
  - 接口：role OTHER/APP_API
  - 实现：`springInfo.isSpringBean = true`，roles 至少含 `SPRING_BEAN`，可进一步标记 EXT_IMPL
  - PSI 可用 `hierarchy.interfaces` 记录“实现了 PaymentService”
- RabbitTemplate（Spring AMQP）：
  - 来自三方库，repoName=Spring 底座；可在 ingest 按包名标 `MQ_CLIENT_CORE`（未来 library role）

## 4. MCP 工具链调用顺序（示例）

> 约定：所有调用默认过滤测试；如有多仓 PSI，可传 `psiCachePath`。

1) 识别入口角色  
`explain_symbol_behavior("com.example.orders.OrderController#createOrder")`  
预期：roles = REST_CONTROLLER + HTTP_HANDLER，isSpringBean=true，isReactiveHandler=false；notes 中提示“直接调用 OrderService#createOrder”。

2) 展开入口 → Service  
`analyze_callees_of_method("com.example.orders.OrderController#createOrder")`  
预期：`callees` 含 `OrderService#createOrder`，category=FRAMEWORK/UNKNOWN，source=calls。

3) 展开 Service → DB/支付/MQ  
`analyze_callees_of_method("com.example.orders.OrderService#createOrder")`  
预期：
  - `OrderMapper#insertOrder`（category: DB）
  - `PaymentService#charge`（category: UNKNOWN，implementations 列出 Alipay/Wechat）
  - `RabbitTemplate#convertAndSend`（category: MQ，若 PSI 没有调用边则在 notes 说明 fallback）

4) 多态扩展点处理  
对 `PaymentService#charge` 的 callee：
  - `implementations`: `AlipayPaymentService#charge`, `WechatPaymentService#charge`
  - 若 PSI 能读出 @Qualifier/@Primary，备注“静态推测当前注入 alipayPaymentService，其余实现仍计入影响集合”
  - implementations 会按 callersCount 降序；moduleSummary 提示触达的模块分布。

5) 反向影响面（可选）  
`analyze_callers_of_method("com.example.orders.OrderService#createOrder")` 查看被谁调用（Controller、CLI、测试），辅助确认入口覆盖面。

6) 角色/排名（影响分析 Profile，可选）  
对查询 “修改 OrderService#createOrder 影响什么？”：开启 `preferredLevels=class,method`，profile=impact_analysis 时排序会综合 role + callers/callees + HTTP/MQ/DB 标签，优先给 Controller/Service/Mapper/MQ。

## 5. Blast Radius 汇总（期望回答结构）

- Controller / Handler：
  - `OrderController#createOrder`（REST_CONTROLLER, HTTP_HANDLER, 非测试）
- Service：
  - `OrderService#createOrder`（@Transactional，调用 DB/支付/MQ）
- 数据库：
  - `OrderMapper#insertOrder` → orders 表（若 mapper SQL 可解析）
- 支付扩展点：
  - 接口：`PaymentService#charge`
  - 实现：`AlipayPaymentService#charge`, `WechatPaymentService#charge`（静态集合，按 callersCount 排序）
- 消息队列：
  - `RabbitTemplate#convertAndSend("order.exchange","order.created", OrderCreatedEvent)`
- 风险提示：
  - 多实现的扩展点存在不确定性；若使用 @Qualifier/@Primary，优先关注对应实现，但其他实现仍在静态影响集合。

## 6. 重现步骤（本仓 + 工具）

- 确认 PSI cache 已包含上述代码；运行 `npm run ingest:milvus` 写入向量。
- 用 MCP CLI / Codex 调用：
  - `explain_symbol_behavior` → 定位入口/角色
  - `analyze_callees_of_method` → 展开向外调用 + 识别 MQ/DB/HTTP + 多实现列表
  - `analyze_callers_of_method` → 反向调用方（可过滤测试）
- 将输出与本文件对照，补充缺失的表名、交换机、实现类备注。

## 7. 限制与待办

- PSI 目前记录的是 **class 级聚合** 的 calls/references，无 per-method 动态调度；需要在显示时注明。
- 多态路由的运行时选择（@Qualifier/profile/condition）无法静态确定，只能列出实现集合并按 callersCount 近似排序。
- 需要在 `semanticRoles.ts`/搜索 pipeline 继续调优 WebMVC 角色误报与 HTTP/MQ/DB 排序权重，以确保入口/核心依赖优先呈现。

# JetBrains MCP vs MVP 差距与验证记录

## 1. 差距分析

| MVP 能力（参考 `doc/idea-enhanced-context-design.md`） | JetBrains 2025.2 内置 MCP 现状 | 差距 |
|-----------------------------------------|-----------------------------------|------|
| 访问完整 PSI（类/方法/字段批量遍历）、导出符号元数据 | 仅提供 `get_symbol_info` 等单点查询工具，无法遍历或导出全量索引 | 需自研 IDEA 插件/Bridge |
| 监听索引增量变更、推送到外部（Milvus） | 无事件推送/订阅机制 | 需自行实现索引监听通道 |
| 自定义工具（如 `search_java_class`, `get_references`） | 内置工具集不可扩展，外部 MCP Server 只能消费 | 需额外 MCP Server + Bridge |
| 运行项目级任务（如 `execute_run_configuration`） | 支持，但前提是 IDE 中有 Run Configuration | 需要先在 IDE 配置运行项 |
| 远程命令/构建 | `execute_terminal_command` 支持，但默认需要用户在 IDE 中确认 | 需开启 “brave mode” 或人工确认 |
| 代码诊断、文件内容读取 | `get_file_problems`, `get_file_text_by_path` 提供单文件级别能力 | 能满足局部诊断，但无法批量导出 |

**结论**：内置 MCP Server 适合作为“IDE 远程助手”，但无法承担“导出语义索引 → 语义搜索”的核心职责；我们仍需按 `doc/idea-enhanced-context-design.md` 第 3 章规划实现 IDEA Bridge 与自定义 MCP Server。

## 2. 验证环境

- IDE：IntelliJ IDEA 2025.2（已启用内置 MCP Server）
- 项目：`/Users/lysander/projects/spring-petclinic-microservices`
- 客户端：Codex CLI 通过 JetBrains MCP 连接

## 3. 验证步骤与结果

| 验证项 | 目标 | 结果 |
|--------|------|------|
| 模块加载 | 确认 IDE 识别全部模块并可被 MCP 查询 | `get_project_modules` 返回 9 个 Java module，覆盖各微服务 | 
| Run Configuration | 验证 `get_run_configurations` / `execute_run_configuration` | 未发现任何 run config，需要在 IDE 中先手动创建 |
| 符号搜索 | 评估 `search_in_files_by_text` 在多模块项目的覆盖度 | 可跨模块定位 `Owner` 类、DTO、Mapper 等多个文件 |
| 符号文档 | 验证 `get_symbol_info` 是否返回 PSI 注释/签名 | 对 `customers/model/Owner` 返回完整注释（Simple JavaBean ...）与作者信息 |
| 代码诊断 | 使用 `get_file_problems` 检查文件警告 | 返回空，说明 IDE 分析无错误且可远程获取 |
| 远程终端 | 测试 `execute_terminal_command` 能否执行 | 调用 `pwd` 超时，推测 IDE 侧等待确认（需启用 “Run without confirmation”） |

## 4. 结论与后续

1. **内置 MCP 适合作为 IDE 辅助入口**：可远程完成单文件级操作（搜索、文档、诊断），但无法满足 MVP 所需的批量 PSI 抽取、索引推送能力。
2. **仍需自建 IDEA Bridge**：要实现 `doc/idea-enhanced-context-design.md` 中的索引管线，必须开发插件或独立桥接进程访问 PSI，并通过自定义 API/MCP 工具对外输出。
3. **操作建议**：
   - 在 IDE 中配置常用 Run Configuration，便于用 `execute_run_configuration` 验证运行链路。
   - 在 MCP Server 设置页启用 “Run shell commands or run configurations without confirmation (brave mode)” 以完成终端命令验证。
   - 同时推进本地 Milvus + embedding 服务，准备承接自研 Bridge 输出。

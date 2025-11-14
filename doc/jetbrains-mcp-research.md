# JetBrains MCP 调研记录（2025-XX-XX）

## 1. 调研目标

- 弄清 IntelliJ IDEA 2025.2 内置 MCP Server 的可用性、接口范围以及可否覆盖本项目在 `doc/idea-enhanced-context-design.md` 中规划的 IDEA Index Bridge 能力。
- 评估在 MacBook Pro M4 Max（128 GB RAM）上本地部署 Milvus 与 embedding 推理的可行性，以支持离线验证流程。

## 2. IntelliJ IDEA 2025.2 内置 MCP Server

### 2.1 可用性与配置

- 2025.2 起 IDE 内置 MCP Server，无需额外插件；可在 `Settings | Tools | MCP Server` 启用并为 Claude Code、Claude Desktop、Cursor、VS Code、Windsurf 等客户端自动写入 SSE / stdio 配置。
- 若客户端未被自动支持，可在 “Manual Client Configuration” 中复制配置模板自行粘贴；同页还提供 “brave mode”，允许外部客户端无确认地执行 IDE 内部命令。
- 参考文档：<https://www.jetbrains.com/help/idea/mcp-server.html>

### 2.2 官方提供的工具能力

| 工具 | 说明 |
|------|------|
| `get_run_configurations` / `execute_run_configuration` | 列出并执行 IDE 内的 Run Configuration，支持超时、输出截断等参数。 |
| `get_file_problems` | 分析指定文件的错误与警告，返回 IDE 的 code insight 结果。 |
| `get_symbol_info` | 依据文件 + 行列号返回 Quick Documentation 信息（声明、签名、文档）。 |
| `rename_refactoring` | 进行上下文感知的重命名，自动更新引用。 |
| `execute_terminal_command` | 在 IDE 集成终端执行命令，可限制超时与输出。 |

> 目前官方文档仅列出 JetBrains 维护的工具集合，未提供第三方扩展机制，因此外部无法向内置 MCP Server 注册自定义工具。

### 2.3 对 IDEA-Enhanced-Context 的影响

- **无法直接替代 IDEA Index Bridge**：上述工具均面向单次交互（获取某个符号、运行某个配置等），并未开放批量遍历 PSI、监听索引变更、导出完整符号图等接口。因此无法满足 `doc/idea-enhanced-context-design.md` 第 3 章中描述的 “符号抽取 + 向量索引” 需求。
- **仍需自研插件**：若要把 IDEA 的语义索引批量送入 Milvus，就必须在 IDE 进程内部署插件（或独立进程通过 IntelliJ Platform SDK）以访问 PSI API，再由我们自定义协议对外暴露。内置 MCP Server 更适合作为团队日常开发时的高阶工具，而非项目的核心数据通道。

## 3. JetBrains MCP Proxy 仓库状态

- GitHub: <https://github.com/JetBrains/mcp-jetbrains>
- 该仓库现已标记为 **Deprecated**，理由是 “核心能力已整合进 2025.2 之后的所有 IntelliJ 平台 IDE”；原本的 Node.js proxy 逻辑（SSE/stdio 转发、`HOST`/`IDE_PORT` 环境变量）现在由 IDE 内置实现。
- 结论：不再需要安装 `@jetbrains/mcp-proxy`，但仓库文档仍可作为排查连接端口、启用外部连接（Settings → Debugger → “Can accept external connections”）等问题的参考。

## 4. 本地 Milvus 与 Embedding 部署可行性

- **Milvus**：M4 Max + 128 GB RAM 足以运行 Milvus Standalone（Milvus + etcd + MinIO）。使用官方 docker-compose（`milvus-standalone-docker-compose.yml`）即可，单机吞吐满足 MVP 阶段对 ~1k 类的索引要求。若仅做原型，可更轻量使用 Qdrant / Faiss。
- **Embedding 推理**：Mac Metal 后端可驱动 7B 量级模型，可选开源 embedding（`BAAI/bge-large-zh`, `jina-embeddings-v2-base-code`, `snowflake-arctic-embed-m` 等），通过 `llama.cpp`、`text-generation-inference` 或 `vLLM` 暴露 HTTP 接口供 MCP Server/Indexer 调用；也可暂用云 API（Voyage、OpenAI）做对照。
- **资源隔离**：建议用 docker compose 或者本地 `launchctl` service 管理 Milvus/embedding，便于在 Mac 上与 IntelliJ 并行运行，同时保证数据留在内网。

## 5. 建议行动

1. **验证内置 MCP 工具**：在最新 IntelliJ 上启用 MCP Server，实测 `get_symbol_info` 等工具的输出格式，供 Codex/Claude 使用。
2. **并行推进 IDEA 插件**：按照 `doc/idea-enhanced-context-design.md` 第 2.1～3.2 节的设计继续实现 Bridge，确保我们能批量提取 PSI 数据。
3. **搭建本地索引链路**：在 Mac 上启动 Milvus + embedding 服务，打通 “IDE 插件 → 向量化 → 检索” 的闭环，为后续云化提供基准。
4. **监控 JetBrains 路线图**：关注官方是否在未来版本开放自定义 MCP 工具接口；一旦开放，可评估把自研 Bridge 变成 IDE 内置工具的可能性。

## 6. 参考资料

- JetBrains 官方文档：<https://www.jetbrains.com/help/idea/mcp-server.html>
- JetBrains MCP Proxy（已废弃）：<https://github.com/JetBrains/mcp-jetbrains>
- 模型/向量检索方案：
  - Milvus 文档：<https://milvus.io/docs>
  - BGE / Jina Embedding 模型介绍：<https://huggingface.co/spaces/mteb/leaderboard>

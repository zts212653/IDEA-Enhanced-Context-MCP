# Docker MCP 使用指南

本指南总结了在本仓库中使用 `MCP_DOCKER` 服务器（即 Docker MCP）时常见的操作方式、参数格式以及排查思路，方便在 CLI 环境下稳定地调用 Docker CLI。

## 1. 基本概念
- **MCP 服务器**：`MCP_DOCKER` 由命令 `docker mcp gateway run` 启动，提供一组工具，其中 `docker` 工具可调用几乎全部 Docker CLI 功能。
- **工具调用形式**：通过 `MCP_DOCKER/mcp-exec` 调用具体工具，典型输入包含 `name`（工具名）和 `arguments`（JSON 字符串，进一步描述参数）。
- **资源**：目前 Docker MCP 未暴露 `resources`，所以不要依赖 `list_mcp_resources` 判断是否已连接。

## 2. 常见操作

### 2.1 查询可用服务器与工具
1. 运行 `/mcp`（或 CLI 中的 `mcp list`）可查看所有已连接的 MCP 服务器、工具列表。
2. 需要确认 `MCP_DOCKER` 处于 `Status: enabled` 才能继续。

### 2.2 调用 `docker` 工具的参数格式
- **始终提供 `args` 数组**：`{"name":"docker","arguments":"{\"args\":[\"ps\"]}"}`。
- **不要直接传入长字符串**：像 `arguments:"compose -f ... up -d"` 会报 JSON 解析错误。
- **包含子命令时逐个拆分**：例如 `docker compose -f … up -d` 应写成：
  ```json
  {
    "name": "docker",
    "arguments": "{\"args\":[\"compose\",\"-f\",\"/path/docker-compose.yml\",\"--project-name\",\"idea-enhanced-context\",\"up\",\"-d\"]}"
  }
  ```
- **需要 STDIN/TTY 的命令**：Docker MCP 目前主要面向非交互式命令，如需交互（例如 `docker login`）建议在本地终端运行或借助其他方式注入凭据。

### 2.3 示例
| 需求 | 调用示例 |
|------|----------|
| 查看容器列表 | `{"name":"docker","arguments":"{\"args\":[\"ps\"]}"}` |
| 查看所有容器 | `{"name":"docker","arguments":"{\"args\":[\"ps\",\"-a\"]}"}` |
| 启动已有容器 | `{"name":"docker","arguments":"{\"args\":[\"start\",\"milvus-standalone\"]}"}` |
| 查看日志 | `{"name":"docker","arguments":"{\"args\":[\"logs\",\"--tail\",\"100\",\"milvus-standalone\"]}"}` |

> 提示：调用日志命令时可先用 `--tail` 限制返回量，避免输出被截断。

## 3. Docker Compose 相关
- Compose 命令同样通过 `args` 逐一拆分，例如：
  ```json
  {
    "name":"docker",
    "arguments":"{\"args\":[\"compose\",\"-f\",\"/Users/lysander/projects/IDEA-Enhanced-Context-MCP/.idea-enhanced-context/milvus/docker-compose.yml\",\"--project-name\",\"idea-enhanced-context\",\"ps\"]}"
  }
  ```
- 如需 `down`、`up -d`、`logs` 等操作，只需替换 `args` 中的后半部分。
- 由于 `docker` 工具直接挂载了宿主机的 Docker Socket，Compose 将按照宿主环境解析路径，请确保路径与本机一致。

## 4. 常见问题与排查
| 问题 | 可能原因 | 处理建议 |
|------|----------|----------|
| `failed to unmarshal arguments` | `arguments` 不是合法 JSON | 改为 JSON 字符串；必要时先用 `jq -n` 生成。 |
| `permission denied ... docker.sock` | 当前会话无权访问 Docker Socket（常见于默认 sandbox） | 需要在 CLI 中请求升级权限或改用本地终端执行。 |
| 命令无输出 | 该命令默认静默（例如 `docker start` 只返回容器名） | 查看返回字段或再运行 `docker ps` 验证。 |
| Compose 容器状态一直是 `health: starting` | Milvus/MinIO 等服务仍在初始化 | 继续观察日志（`docker logs`），通常 30~60 秒会转为 healthy；若一直失败需排查卷/端口。 |

## 5. 工作流建议
1. 在 `/doc/quick_start.sh` 运行过一遍后，Milvus 的 Compose 文件会落在 `.idea-enhanced-context/milvus/docker-compose.yml`，可直接用 Docker MCP 管理。
2. 养成“先 `docker ps -a` 看状态，再决定 `start/stop/logs`”的习惯，避免误操作。
3. 如需批量执行多条命令，可写一个脚本，由本地 shell 运行；MCP 适合一次一条命令，便于调试与审计。

## 6. 参考
- Docker MCP 官方文档：`docker mcp --help`
- 本仓库相关脚本：`doc/quick_start.sh`、`.idea-enhanced-context/milvus/docker-compose.yml`
- Milvus 健康检查：`curl http://localhost:9091/healthz`

如需扩展或补充更多经验，可在本文件基础上继续追加章节。欢迎在日常使用后记录新的坑位和最佳实践。***

#!/bin/bash
# quick_start.sh - 一键搭建本地索引链路（Milvus + Embedding）
# 适用于：macOS（建议 M4 Max 128G 环境）

set -euo pipefail

echo "🚀 开始初始化 IDEA-Enhanced-Context 本地索引环境..."
echo ""

if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ 此脚本仅支持 macOS"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_ROOT="${IEC_ENV_DIR:-$REPO_ROOT/.idea-enhanced-context}"
MILVUS_DIR="$DATA_ROOT/milvus"
COMPOSE_FILE="$MILVUS_DIR/docker-compose.yml"
MODEL_NAME="${EMBED_MODEL:-manutic/nomic-embed-code:latest}"
PY_TEST_FILE="$DATA_ROOT/test_installation.py"
README_FILE="$DATA_ROOT/README.md"

mkdir -p "$MILVUS_DIR"

echo "📁 当前仓库根目录: $REPO_ROOT"
echo "📁 本地环境目录: $DATA_ROOT"
echo ""

# 1. 依赖检查
echo "📋 检查前置条件..."
if ! command -v docker >/dev/null 2>&1; then
    echo "❌ 未检测到 Docker，请先安装 Docker Desktop"
    exit 1
fi
echo "✅ Docker: $(docker --version)"

if ! command -v docker compose >/dev/null 2>&1; then
    echo "❌ 未检测到 docker compose"
    exit 1
fi
echo "✅ Docker Compose: $(docker compose version --short)"

if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "❌ 需要 curl 或 wget 用于下载 Milvus 配置文件"
    exit 1
fi

# 2. 准备 Milvus Compose
echo ""
echo "📦 准备 Milvus Standalone..."
if [[ ! -f "$COMPOSE_FILE" ]]; then
    DOWNLOAD_URL="https://github.com/milvus-io/milvus/releases/download/v2.6.4/milvus-standalone-docker-compose.yml"
    echo "⬇️  下载 Milvus Compose 文件到 $COMPOSE_FILE"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$DOWNLOAD_URL" -o "$COMPOSE_FILE"
    else
        wget -q "$DOWNLOAD_URL" -O "$COMPOSE_FILE"
    fi
else
    echo "ℹ️  发现已有 Compose 文件，跳过下载"
fi

echo "▶️  启动 Milvus（使用已下载的镜像）..."
docker compose -f "$COMPOSE_FILE" --project-name idea-enhanced-context down >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" --project-name idea-enhanced-context up -d

echo "⏳ 等待 Milvus 服务就绪..."
sleep 5

if docker compose -f "$COMPOSE_FILE" --project-name idea-enhanced-context ps | grep -q "Up"; then
echo "✅ Milvus 已启动 (gRPC 19530 / HTTP 9091)"
else
    echo "❌ Milvus 启动失败，请查看日志："
    docker compose -f "$COMPOSE_FILE" --project-name idea-enhanced-context logs
    exit 1
fi

# 3. 准备 Embedding 服务（Ollama）
echo ""
echo "📦 检查 Ollama..."
if ! command -v ollama >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
        brew install ollama
    else
        echo "❌ 未检测到 Ollama，且 Homebrew 不可用，请手动安装 https://ollama.com/download"
        exit 1
    fi
fi
echo "✅ Ollama: $(ollama --version)"

if ! pgrep -x "ollama" >/dev/null 2>&1; then
    echo "▶️  启动 Ollama 守护进程..."
    nohup ollama serve >/tmp/ollama.log 2>&1 &
    sleep 3
fi

echo "⬇️  确保本地存在模型 $MODEL_NAME ..."
ollama pull "$MODEL_NAME"
MODEL_ALIAS="${MODEL_NAME%%:*}"
echo "✅ 模型就绪：$MODEL_NAME"

# 4. Python 依赖
echo ""
echo "📦 安装 Python 依赖 (pymilvus)..."
python3 -m pip install --user pymilvus >/tmp/pip-install.log 2>&1 || python3 -m pip install pymilvus
echo "✅ pymilvus 安装完成"

# 5. 生成测试脚本
echo ""
echo "📝 写入验证脚本：$PY_TEST_FILE"
cat > "$PY_TEST_FILE" <<PYTHON_EOF
from pymilvus import connections, utility
import ollama
import sys

print("🧪 开始验证本地索引链路\\n")

try:
    connections.connect("default", host="localhost", port="19530")
    version = utility.get_server_version()
    print(f"✅ Milvus 连接成功 (版本: {version})")
    connections.disconnect("default")
except Exception as exc:
    print(f"❌ Milvus 连接失败: {exc}")
    sys.exit(1)

try:
    result = ollama.embeddings(model="${MODEL_ALIAS}", prompt="public class Demo {}")
    dim = len(result["embedding"])
    print(f"✅ Embedding 生成成功 (维度: {dim})")
except Exception as exc:
    print(f"❌ Embedding 生成失败: {exc}")
    sys.exit(1)

print("\\n🎉 验证通过，可以开始接入 IDEA Bridge！")
PYTHON_EOF

python3 "$PY_TEST_FILE"

# 6. 输出 README
echo ""
echo "📝 更新本地环境 README：$README_FILE"
cat > "$README_FILE" <<README_EOF
# IDEA-Enhanced-Context 本地索引环境

- Milvus Standalone (docker compose 项目名: idea-enhanced-context)
- Embedding 服务：$MODEL_NAME (Ollama)
- 数据目录：$DATA_ROOT

## 常用命令

```bash
# 查看服务状态
docker compose -f $COMPOSE_FILE --project-name idea-enhanced-context ps

# 停止服务
docker compose -f $COMPOSE_FILE --project-name idea-enhanced-context down

# 重启服务
docker compose -f $COMPOSE_FILE --project-name idea-enhanced-context up -d
```

## 健康检查

- Milvus HTTP 健康接口：\`curl http://localhost:9091/healthz\`  
  （浏览器直接打开 9091 根路径会返回 404 属正常现象）
- MinIO 控制台：<http://localhost:9001>（账号/密码 `minioadmin`）

## 下一步

1. 在 IDE 中运行 IDEA Bridge 插件，指向 Milvus (localhost:19530) 与 Embedding API (Ollama)。
2. 使用 \`python3 $PY_TEST_FILE\` 随时复查链路。
3. 如需清理数据，可删除目录：\`rm -rf $DATA_ROOT\`（停服后执行）。

README_EOF

echo ""
echo "✅ 本地索引链路已准备完毕。数据目录：$DATA_ROOT"
echo "   - Milvus Compose: $COMPOSE_FILE"
echo "   - 验证脚本: $PY_TEST_FILE"
echo "   - README: $README_FILE"
echo "👉 如需自定义目录，可设置 IEC_ENV_DIR=/path/to/dir 重新运行脚本。"

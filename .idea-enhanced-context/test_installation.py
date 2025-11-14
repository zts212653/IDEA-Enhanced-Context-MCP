import os
import sys

for var in ("ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
    os.environ.pop(var, None)

os.environ.setdefault("NO_PROXY", "localhost,127.0.0.1")
os.environ.setdefault("OLLAMA_HOST", "http://127.0.0.1:11434")

from pymilvus import connections, utility  # noqa: E402
import ollama  # noqa: E402

MODEL = os.environ.get("IEC_EMBED_MODEL", "manutic/nomic-embed-code")
PROMPT = "public class Demo {}"

print("🧪 开始验证本地索引链路\n")

try:
    connections.connect("default", host="localhost", port="19530")
    version = utility.get_server_version()
    print(f"✅ Milvus 连接成功 (版本: {version})")
    connections.disconnect("default")
except Exception as exc:
    print(f"❌ Milvus 连接失败: {exc}")
    sys.exit(1)

try:
    result = ollama.embeddings(model=MODEL, prompt=PROMPT)
    dim = len(result["embedding"])
    print(f"✅ Embedding 生成成功 (模型: {MODEL}, 维度: {dim})")
except Exception as exc:
    print(f"❌ Embedding 生成失败: {exc}")
    sys.exit(1)

print("\n🎉 验证通过，可以开始接入 IDEA Bridge！")

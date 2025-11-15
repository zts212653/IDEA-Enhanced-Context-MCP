import path from "node:path";
import os from "node:os";

export interface BridgeConfig {
  projectRoot: string;
  port: number;
  psiCachePath: string;
  milvusHttpEndpoint: string;
  milvusGrpcAddress: string;
  milvusCollection: string;
  milvusVectorField: string;
  milvusDatabase: string;
  embeddingModel: string;
  embeddingHost: string;
  resetMilvusCollection: boolean;
}

function resolveTilde(p: string) {
  if (!p.startsWith("~")) {
    return p;
  }
  return path.join(os.homedir(), p.slice(1));
}

export function loadConfig(): BridgeConfig {
  const projectRoot =
    process.env.BRIDGE_PROJECT_ROOT ??
    path.join(os.homedir(), "projects", "spring-petclinic-microservices");

  const psiCachePath =
    process.env.BRIDGE_PSI_CACHE ??
    path.join(projectRoot, ".idea-bridge", "psi-cache.json");

  return {
    projectRoot: resolveTilde(projectRoot),
    port: Number(process.env.BRIDGE_PORT ?? 63000),
    psiCachePath: resolveTilde(psiCachePath),
    milvusHttpEndpoint:
      process.env.MILVUS_HTTP_ENDPOINT ?? "http://127.0.0.1:9091",
    milvusGrpcAddress: process.env.MILVUS_ADDRESS ?? "127.0.0.1:19530",
    milvusCollection: process.env.MILVUS_COLLECTION ?? "idea_symbols",
    milvusVectorField: process.env.MILVUS_VECTOR_FIELD ?? "embedding",
    milvusDatabase: process.env.MILVUS_DATABASE ?? "default",
    embeddingModel:
      process.env.IEC_EMBED_MODEL ??
      process.env.EMBED_MODEL ??
      "manutic/nomic-embed-code",
    embeddingHost:
      process.env.OLLAMA_HOST ??
      process.env.EMBEDDING_HOST ??
      "http://127.0.0.1:11434",
    resetMilvusCollection: process.env.MILVUS_RESET === "1",
  };
}

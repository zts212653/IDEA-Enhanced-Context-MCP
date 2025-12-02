import path from "node:path";
import os from "node:os";

export interface BridgeConfig {
  projectRoot: string;
  port: number;
  psiCachePath: string;
  psiCacheDir?: string;
  milvusHttpEndpoint: string;
  milvusGrpcAddress: string;
  milvusCollection: string;
  milvusVectorField: string;
  milvusDatabase: string;
  embeddingProvider: string;
  embeddingTaskPassage: string;
  embeddingTaskQuery: string;
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

  const defaultCachePath = path.join(
    process.cwd(),
    ".idea-bridge",
    "psi-cache.json",
  );

  const psiCachePath =
    process.env.BRIDGE_PSI_CACHE ?? defaultCachePath;
  const psiCacheDir = process.env.BRIDGE_PSI_CACHE_DIR
    ? resolveTilde(process.env.BRIDGE_PSI_CACHE_DIR)
    : undefined;

  return {
    projectRoot: resolveTilde(projectRoot),
    port: Number(process.env.BRIDGE_PORT ?? 63000),
    psiCachePath: resolveTilde(psiCachePath),
    psiCacheDir,
    milvusHttpEndpoint:
      process.env.MILVUS_HTTP_ENDPOINT ?? "http://127.0.0.1:9091",
    milvusGrpcAddress: process.env.MILVUS_ADDRESS ?? "127.0.0.1:19530",
    milvusCollection: process.env.MILVUS_COLLECTION ?? "idea_symbols",
    milvusVectorField: process.env.MILVUS_VECTOR_FIELD ?? "embedding",
    milvusDatabase: process.env.MILVUS_DATABASE ?? "default",
    embeddingProvider:
      process.env.EMBEDDING_PROVIDER?.toLowerCase() ?? "ollama",
    embeddingTaskPassage:
      process.env.EMBEDDING_TASK_PASSAGE ?? "retrieval.passage",
    embeddingTaskQuery:
      process.env.EMBEDDING_TASK_QUERY ?? "retrieval.query",
    embeddingModel:
      process.env.EMBEDDING_MODEL ??
      process.env.IEC_EMBED_MODEL ??
      process.env.EMBED_MODEL ??
      process.env.OLLAMA_MODEL ??
      "manutic/nomic-embed-code",
    embeddingHost:
      process.env.OLLAMA_HOST ??
      process.env.EMBEDDING_HOST ??
      "http://127.0.0.1:11434",
    resetMilvusCollection: process.env.MILVUS_RESET === "1",
  };
}

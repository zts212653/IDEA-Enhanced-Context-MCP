export interface MilvusResolvedConfig {
  address: string;
  collection: string;
  vectorField: string;
  metricType: string;
  searchParams: Record<string, number | string>;
  outputFields: string[];
  embeddingProvider: string;
  embeddingTaskQuery: string;
  embeddingModel: string;
  embeddingHost: string;
}

export function resolveMilvusConfig():
  | MilvusResolvedConfig
  | undefined {
  if (process.env.DISABLE_MILVUS === "1") {
    return undefined;
  }

  return {
    address: process.env.MILVUS_ADDRESS ?? "127.0.0.1:19530",
    collection:
      process.env.MILVUS_COLLECTION ??
      process.env.MILVUS_COLLECTION_NAME ??
      "idea_symbols",
    vectorField:
      process.env.MILVUS_VECTOR_FIELD ??
      process.env.MILVUS_ANNS_FIELD ??
      "embedding",
    metricType: process.env.MILVUS_METRIC ?? "IP",
    searchParams: {
      nprobe: Number(process.env.MILVUS_PARAM_NPROBE ?? 16),
    },
    outputFields: [
      "index_level",
      "repo_name",
      "module_name",
      "module_path",
      "package_name",
      "symbol_name",
      "summary",
      "metadata",
      "fqn",
    ],
    embeddingProvider:
      process.env.EMBEDDING_PROVIDER?.toLowerCase() ?? "ollama",
    embeddingTaskQuery:
      process.env.EMBEDDING_TASK_QUERY ?? "retrieval.query",
    embeddingModel:
      process.env.IEC_EMBED_MODEL ??
      process.env.EMBED_MODEL ??
      "manutic/nomic-embed-code",
    embeddingHost:
      process.env.OLLAMA_HOST ??
      process.env.EMBEDDING_HOST ??
      "http://127.0.0.1:11434",
  };
}

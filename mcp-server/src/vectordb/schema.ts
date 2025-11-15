import { MilvusClient, DataType } from "@zilliz/milvus2-sdk-node";

import type { MilvusResolvedConfig } from "../milvusConfig.js";

const BASE_FIELDS = [
  {
    name: "id",
    data_type: DataType.VarChar,
    is_primary_key: true,
    type_params: { max_length: "512" },
  },
  {
    name: "index_level",
    data_type: DataType.VarChar,
    type_params: { max_length: "32" },
  },
  {
    name: "repo_name",
    data_type: DataType.VarChar,
    type_params: { max_length: "256" },
  },
  {
    name: "module_name",
    data_type: DataType.VarChar,
    type_params: { max_length: "256" },
  },
  {
    name: "module_path",
    data_type: DataType.VarChar,
    type_params: { max_length: "512" },
  },
  {
    name: "package_name",
    data_type: DataType.VarChar,
    type_params: { max_length: "512" },
  },
  {
    name: "symbol_name",
    data_type: DataType.VarChar,
    type_params: { max_length: "512" },
  },
  {
    name: "fqn",
    data_type: DataType.VarChar,
    type_params: { max_length: "1024" },
  },
  {
    name: "summary",
    data_type: DataType.VarChar,
    type_params: { max_length: "2048" },
  },
  {
    name: "metadata",
    data_type: DataType.VarChar,
    type_params: { max_length: "8192" },
  },
];

export async function ensureCollectionExists(config: MilvusResolvedConfig) {
  const client = new MilvusClient({ address: config.address });
  const exists = await client.hasCollection({
    collection_name: config.collection,
  });

  if (!exists) {
    await client.createCollection({
      collection_name: config.collection,
      fields: [
        ...BASE_FIELDS,
        {
          name: config.vectorField,
          data_type: DataType.FloatVector,
          type_params: { dim: "1536" },
        },
      ],
    });
  }

  try {
    await client.createIndex({
      collection_name: config.collection,
      field_name: config.vectorField,
      index_name: `${config.vectorField}_ivf_flat`,
      index_type: "IVF_FLAT",
      metric_type: config.metricType ?? "IP",
      params: { nlist: 1024 },
    });
  } catch (error) {
    if (!(error instanceof Error && /index exist/i.test(error.message))) {
      throw error;
    }
  }
}

export async function describeCollection(config: MilvusResolvedConfig) {
  const client = new MilvusClient({ address: config.address });
  const description = await client.describeCollection({
    collection_name: config.collection,
  });
  const indexes = await client.describeIndex({
    collection_name: config.collection,
    field_name: config.vectorField,
  });
  return { description, indexes };
}

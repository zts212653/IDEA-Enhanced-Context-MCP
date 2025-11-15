import { resolveMilvusConfig } from "../milvusConfig.js";
import { describeCollection, ensureCollectionExists } from "../vectordb/schema.js";

async function main() {
  const config = resolveMilvusConfig();
  if (!config) {
    console.error("[schema] MILVUS is disabled (DISABLE_MILVUS=1)");
    process.exit(1);
  }

  await ensureCollectionExists(config);
  const { description, indexes } = await describeCollection(config);
  console.log("Collection:", description.collection_name);
  console.log("Fields:");
  const descAny = description as any;
  const fields = descAny.schema?.fields ?? descAny.fields ?? [];
  fields.forEach((field: any) => {
    console.log(
      `  - ${field.name} (${field.data_type})${field.is_primary_key ? " [PK]" : ""}`,
    );
  });

  console.log("Indexes:");
  indexes.index_descriptions?.forEach((idx: any) => {
    console.log(
      `  - ${idx.index_name} on ${idx.field_name} (${idx.index_type}, metric=${idx.metric_type})`,
    );
  });
}

main().catch((error) => {
  console.error("[schema] inspection failed:", error);
  process.exit(1);
});

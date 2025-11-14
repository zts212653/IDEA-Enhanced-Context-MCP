import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SearchArguments, MilvusSearchHandle } from "./searchPipeline.js";
import type { SymbolRecord } from "./types.js";

const DEFAULT_ADDRESS = "127.0.0.1:19530";
const DEFAULT_COLLECTION = "idea_symbols";
const DEFAULT_VECTOR_FIELD = "embedding";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../idea-bridge/scripts/milvus_query.py",
);

type MilvusConfig = {
  address: string;
  collection: string;
  vectorField: string;
  metricType: string;
  searchParams: Record<string, number | string>;
  outputFields: string[];
  embeddingModel: string;
  embeddingHost: string;
};

function resolveConfig(): MilvusConfig | undefined {
  if (process.env.DISABLE_MILVUS === "1") {
    return undefined;
  }

  return {
    address: process.env.MILVUS_ADDRESS ?? DEFAULT_ADDRESS,
    collection:
      process.env.MILVUS_COLLECTION ??
      process.env.MILVUS_COLLECTION_NAME ??
      DEFAULT_COLLECTION,
    vectorField:
      process.env.MILVUS_VECTOR_FIELD ?? process.env.MILVUS_ANNS_FIELD ??
      DEFAULT_VECTOR_FIELD,
    metricType: process.env.MILVUS_METRIC ?? "IP",
    searchParams: {
      nprobe: Number(process.env.MILVUS_PARAM_NPROBE ?? 16),
    },
    outputFields: (
      process.env.MILVUS_OUTPUT_FIELDS ??
      "fqn,summary,module,kind,references,last_modified_days"
    )
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean),
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

async function generateEmbedding(
  text: string,
  model: string,
  host: string,
): Promise<number[] | undefined> {
  try {
    const response = await fetch(new URL("/api/embeddings", host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed (${response.status}) ${await response.text()}`,
      );
    }
    const json = (await response.json()) as { embedding?: number[] };
    return json.embedding;
  } catch (error) {
    console.warn("[idea-enhanced-context] embedding generation failed:", error);
    return undefined;
  }
}

function fallbackEmbedding(text: string, dimension = 384): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const idx = code % dimension;
    vector[idx] += (code % 7) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vector.map((val) => Number((val / norm).toFixed(6)));
}

function formatRecords(raw: any[]): SymbolRecord[] {
  return raw.map((row) => ({
    fqn: row.fqn ?? row.id ?? "unknown",
    kind: (row.kind ?? "CLASS") as SymbolRecord["kind"],
    module: row.module ?? "default",
    summary: row.summary ?? "",
    scoreHints: {
      references: row.references ?? row.reference_count,
      lastModifiedDays:
        row.last_modified_days ?? row.lastModifiedDays ?? undefined,
    },
  }));
}

async function runPythonSearch(payload: Record<string, unknown>): Promise<any[]> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "milvus-query-"));
  const requestPath = path.join(tmpDir, "request.json");
  await fs.writeFile(requestPath, JSON.stringify(payload));

  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, requestPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let data = "";
    proc.stdout.on("data", (chunk) => {
      data += chunk.toString();
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve(data);
      else reject(new Error(`milvus_query.py exited with code ${code}`));
    });
    proc.on("error", (error) => reject(error));
  });

  await fs.rm(tmpDir, { recursive: true, force: true });
  const parsed = JSON.parse(result) as { results: any[] };
  return parsed.results ?? [];
}

export function createMilvusSearchClient(): MilvusSearchHandle | undefined {
  const config = resolveConfig();
  if (!config) {
    return undefined;
  }

  return {
    async search(args: SearchArguments) {
      let embedding = await generateEmbedding(
        args.query,
        config.embeddingModel,
        config.embeddingHost,
      );

      if (!embedding) {
        embedding = fallbackEmbedding(args.query);
      }

      const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);

      try {
        const rows = await runPythonSearch({
          collectionName: config.collection,
          vectorField: config.vectorField,
          vector: embedding,
          limit,
          moduleFilter: args.moduleFilter,
          milvusAddress: config.address,
          metricType: config.metricType,
          searchParams: config.searchParams,
          outputFields: config.outputFields,
        });
        return rows.length ? formatRecords(rows) : undefined;
      } catch (error) {
        console.warn("[idea-enhanced-context] Milvus search bridge failed:", error);
        return undefined;
      }
    },
  };
}

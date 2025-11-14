import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SearchArguments, MilvusSearchHandle } from "./searchPipeline.js";
import type { SymbolRecord, UploadInfo } from "./types.js";

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

function parseMetadata(metadata?: string) {
  if (!metadata) return undefined;
  try {
    return JSON.parse(metadata);
  } catch {
    return undefined;
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string") as string[];
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return undefined;
}

function normalizeHierarchy(meta: Record<string, any> | undefined) {
  if (!meta) return undefined;
  if (meta.hierarchy) {
    return {
      superClass: meta.hierarchy.superClass,
      interfaces: asStringArray(meta.hierarchy.interfaces) ?? [],
    };
  }
  if (meta.hierarchySummary) {
    return {
      superClass: Array.isArray(meta.hierarchySummary.superClasses)
        ? meta.hierarchySummary.superClasses[0]
        : meta.hierarchySummary.superClasses,
      interfaces:
        asStringArray(meta.hierarchySummary.interfaces) ??
        asStringArray(meta.hierarchySummary.superInterfaces) ??
        [],
    };
  }
  if (meta.superClass || meta.interfaces) {
    return {
      superClass: meta.superClass,
      interfaces: asStringArray(meta.interfaces) ?? [],
    };
  }
  return undefined;
}

function normalizeRelations(meta: Record<string, any> | undefined) {
  if (!meta?.relations) return undefined;
  return {
    calls: asStringArray(meta.relations.calls),
    calledBy: asStringArray(meta.relations.calledBy),
    references: asStringArray(meta.relations.references),
  };
}

function normalizeSpring(meta: Record<string, any> | undefined) {
  const spring = meta?.spring ?? meta?.springInfo;
  if (!spring) return undefined;
  return {
    isSpringBean: spring.isSpringBean,
    beanType: spring.beanType,
    beanName: spring.beanName,
    autoWiredDependencies: asStringArray(spring.autoWiredDependencies),
    annotations: asStringArray(spring.annotations),
  };
}

function normalizeUpload(meta: Record<string, any> | undefined): UploadInfo | undefined {
  if (!meta) return undefined;
  const upload = meta.upload ?? meta.uploadMeta;
  if (!upload || typeof upload !== "object") return undefined;
  return {
    schemaVersion: upload.schemaVersion ?? upload.version,
    projectName: upload.projectName,
    generatedAt: upload.generatedAt,
    uploadedAt: upload.uploadedAt ?? upload.timestamp,
    batchCount: upload.batchCount,
  };
}

function formatRecords(raw: any[]): SymbolRecord[] {
  return raw.map((row) => {
    const parsed = parseMetadata(row.metadata);
    const level = row.index_level ?? parsed?.level ?? "class";
    let kind: SymbolRecord["kind"] = "CLASS";
    if (level === "method") kind = "METHOD";
    else if (level === "module") kind = "MODULE";
    else if (level === "repository") kind = "REPOSITORY";
    const metadata = parsed ?? {};
    const repoName = row.repo_name ?? metadata.repoName ?? metadata.repo_name;
    const modulePath = row.module_path ?? metadata.modulePath;
    const packageName = row.package_name ?? metadata.package ?? metadata.packageName;

    const uploadInfo = normalizeUpload(parsed);

    return {
      fqn: row.fqn ?? row.symbol_name ?? row.repo_name ?? "unknown",
      kind,
      module: row.module_name ?? parsed?.module ?? "default",
      modulePath,
      repoName,
      packageName,
      summary: row.summary ?? parsed?.summary ?? "",
      metadata,
      indexLevel: level,
      relations: normalizeRelations(metadata),
      hierarchy: normalizeHierarchy(metadata),
      springInfo: normalizeSpring(metadata),
      uploadInfo,
      scoreHints: {
        references: parsed?.references ?? parsed?.referenceCount,
        lastModifiedDays: parsed?.lastModifiedDays,
      },
    };
  });
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
          levels: args.preferredLevels ?? ["class", "method"],
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

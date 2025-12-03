import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import {
  fallbackEmbedding,
  generateEmbedding,
  symbolToEmbeddingText,
} from "../embedding.js";
import { loadInitialSymbols } from "../psiDataSource.js";
import type { MethodInfo, SymbolRecord } from "../types.js";

type IndexLevel = "repository" | "module" | "class" | "method";

interface IndexEntry {
  id: string;
  level: IndexLevel;
  repoName: string;
  moduleName?: string;
  modulePath?: string;
  packageName?: string;
  symbolName?: string;
  fqn?: string;
  summary: string;
  metadata: Record<string, unknown>;
  embeddingText: string;
}

type ModuleGroup = {
  moduleName: string;
  modulePath: string;
  classes: SymbolRecord[];
};

function adjustVectorLength(vector: number[], dimension: number): number[] {
  if (vector.length === dimension) return vector;
  if (vector.length > dimension) {
    return vector.slice(0, dimension);
  }
  const padded = vector.slice();
  while (padded.length < dimension) {
    padded.push(0);
  }
  return padded;
}

function truncateArray<T>(values: T[], limit = 10) {
  return values.length > limit ? values.slice(0, limit) : values;
}

function parseCsvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function applyEnvFilters(records: SymbolRecord[]): SymbolRecord[] {
  let filtered = records;
  const moduleFilters = parseCsvEnv("INGEST_MODULE_FILTER");
  if (moduleFilters) {
    const before = filtered.length;
    filtered = filtered.filter((record) => {
      return moduleFilters.some((mod) => {
        if (!mod) return false;
        if (record.module === mod) return true;
        if (record.modulePath && record.modulePath.includes(mod)) return true;
        return false;
      });
    });
    console.log(
      `[idea-bridge] INGEST_MODULE_FILTER active: ${moduleFilters.join(",")} records ${before} -> ${filtered.length}`,
    );
  }
  return filtered;
}

function vectorNorm(vec: number[]): number {
  let sum = 0;
  for (const v of vec) sum += v * v;
  return Math.sqrt(sum);
}

function buildIndexEntries(records: SymbolRecord[]): IndexEntry[] {
  if (records.length === 0) return [];

  const repoName = records[0].repoName;
  const entries: IndexEntry[] = [];
  const modules = groupByModule(records);

  entries.push(buildRepoEntry(repoName, modules, records.length));
  for (const mod of modules.values()) {
    entries.push(buildModuleEntry(repoName, mod));
  }
  for (const symbol of records) {
    entries.push(buildClassEntry(symbol));
    for (const method of symbol.methods) {
      entries.push(buildMethodEntry(symbol, method));
    }
  }

  return entries;
}

function groupByModule(records: SymbolRecord[]) {
  const map = new Map<string, ModuleGroup>();
  for (const record of records) {
    const key = record.module || "root";
    const existing = map.get(key);
    if (existing) {
      existing.classes.push(record);
    } else {
      map.set(key, {
        moduleName: key,
        modulePath: record.modulePath,
        classes: [record],
      });
    }
  }
  return map;
}

function buildRepoEntry(
  repoName: string,
  modules: Map<string, ModuleGroup>,
  classCount: number,
): IndexEntry {
  const moduleSummaries = Array.from(modules.values()).map((mod) => ({
    module: mod.moduleName,
    path: mod.modulePath,
    classCount: mod.classes.length,
    springBeans: mod.classes.filter((cls) => cls.springInfo?.isSpringBean).length,
  }));
  const totalSpringBeans = moduleSummaries.reduce(
    (sum, mod) => sum + mod.springBeans,
    0,
  );

  const metadata = {
    moduleCount: modules.size,
    classCount,
    modules: truncateArray(moduleSummaries, 12),
    springBeans: totalSpringBeans,
  };

  const embeddingText = [
    `Repository ${repoName}`,
    `Modules: ${modules.size}`,
    `Total classes: ${classCount}`,
    `Total Spring beans: ${totalSpringBeans}`,
    ...truncateArray(moduleSummaries, 8).map(
      (m) =>
        `Module ${m.module} (${m.classCount} classes, ${m.springBeans} beans)`,
    ),
  ].join("\n");

  return {
    id: `repo:${repoName}`,
    level: "repository",
    repoName,
    symbolName: repoName,
    fqn: repoName,
    summary: `Repository ${repoName} with ${modules.size} modules and ${classCount} classes`,
    metadata,
    embeddingText,
  };
}

function buildModuleEntry(repoName: string, module: ModuleGroup): IndexEntry {
  const packages = new Set(module.classes.map((cls) => cls.packageName));
  const springBeans = module.classes.filter((cls) => cls.springInfo?.isSpringBean);
  const dependencies = new Set<string>();
  const relationStats = {
    calls: 0,
    calledBy: 0,
    references: 0,
  };
  const hierarchySummary = {
    superClasses: new Set<string>(),
    interfaces: new Set<string>(),
  };
  for (const cls of module.classes) {
    cls.dependencies.imports.forEach((dep) => dependencies.add(dep));
    cls.relations?.calls?.length &&
      (relationStats.calls += cls.relations.calls.length);
    cls.relations?.calledBy?.length &&
      (relationStats.calledBy += cls.relations.calledBy.length);
    cls.relations?.references?.length &&
      (relationStats.references += cls.relations.references.length);
    if (cls.hierarchy?.superClass) {
      hierarchySummary.superClasses.add(cls.hierarchy.superClass);
    }
    cls.hierarchy?.interfaces.forEach((item) =>
      hierarchySummary.interfaces.add(item),
    );
  }

  const metadata = {
    repoName,
    modulePath: module.modulePath,
    packageCount: packages.size,
    packages: truncateArray(Array.from(packages), 10),
    classCount: module.classes.length,
    springBeans: truncateArray(
      springBeans.map((bean) => bean.fqn),
      10,
    ),
    dependencies: truncateArray(Array.from(dependencies), 15),
    relationSummary: relationStats,
    hierarchySummary: {
      superClasses: truncateArray(Array.from(hierarchySummary.superClasses), 10),
      interfaces: truncateArray(Array.from(hierarchySummary.interfaces), 10),
    },
  };

  const embeddingText = [
    `Module ${module.moduleName} in repo ${repoName}`,
    `Path: ${module.modulePath}`,
    `Packages: ${Array.from(packages).join(", ")}`,
    `Classes: ${module.classes.length}`,
    `Spring beans: ${springBeans.length}`,
    `Dependencies: ${Array.from(dependencies).join(", ")}`,
    `Relations: calls=${relationStats.calls}, calledBy=${relationStats.calledBy}, references=${relationStats.references}`,
  ].join("\n");

  return {
    id: `module:${repoName}:${module.moduleName}`,
    level: "module",
    repoName,
    moduleName: module.moduleName,
    modulePath: module.modulePath,
    symbolName: module.moduleName,
    fqn: `${repoName}:${module.moduleName}`,
    summary: `Module ${module.moduleName} (${module.classes.length} classes, ${packages.size} packages)`,
    metadata,
    embeddingText,
  };
}

function buildClassEntry(symbol: SymbolRecord): IndexEntry {
  const callersCount = symbol.relations?.calledBy?.length ?? 0;
  const calleesCount = symbol.relations?.calls?.length ?? 0;
  const referencesCount = symbol.relations?.references?.length ?? 0;
  const relationSummary =
    callersCount || calleesCount || referencesCount
      ? {
          callersCount,
          calleesCount,
          referencesCount,
        }
      : undefined;

  const metadata = {
    module: symbol.module,
    modulePath: symbol.modulePath,
    package: symbol.packageName,
    annotations: truncateArray(symbol.annotations.map((ann) => ann.fqn ?? ann.name)),
    fields: truncateArray(symbol.fields.map((field) => field.name)),
    methods: truncateArray(symbol.methods.map((method) => method.signature)),
    dependencies: symbol.dependencies,
    spring: symbol.springInfo,
    filePath: symbol.relativePath,
    quality: symbol.quality,
    upload: symbol.uploadMeta,
    hierarchy: symbol.hierarchy,
    relations: symbol.relations,
    callersCount: callersCount || undefined,
    calleesCount: calleesCount || undefined,
    referencesCount: referencesCount || undefined,
    relationSummary,
  };

  return {
    id: `class:${symbol.fqn}`,
    level: "class",
    repoName: symbol.repoName,
    moduleName: symbol.module,
    modulePath: symbol.modulePath,
    packageName: symbol.packageName,
    symbolName: symbol.fqn,
    fqn: symbol.fqn,
    summary: symbol.summary,
    metadata,
    embeddingText: symbolToEmbeddingText(symbol),
  };
}

function buildMethodEntry(symbol: SymbolRecord, method: MethodInfo): IndexEntry {
  const callersCount = symbol.relations?.calledBy?.length ?? 0;
  const calleesCount = symbol.relations?.calls?.length ?? 0;
  const referencesCount = symbol.relations?.references?.length ?? 0;
  const relationSummary =
    callersCount || calleesCount || referencesCount
      ? {
          callersCount,
          calleesCount,
          referencesCount,
        }
      : undefined;

  const metadata = {
    class: symbol.fqn,
    module: symbol.module,
    parameters: method.parameters,
    returnType: method.returnTypeFqn ?? method.returnType,
    annotations: method.annotations?.map((ann) => ann.fqn ?? ann.name),
    visibility: method.visibility,
    callersCount: callersCount || undefined,
    calleesCount: calleesCount || undefined,
    referencesCount: referencesCount || undefined,
    relationSummary,
  };

  const embeddingText = [
    `Method ${method.name} of class ${symbol.fqn}`,
    `Signature: ${method.signature}`,
    `Return type: ${method.returnTypeFqn ?? method.returnType}`,
    `Parameters: ${method.parameters
      .map((param) => `${param.typeFqn ?? param.type} ${param.name}`)
      .join(", ")}`,
    `Module: ${symbol.module}`,
    `Package: ${symbol.packageName}`,
  ].join("\n");

  return {
    id: `method:${symbol.fqn}#${method.name}`,
    level: "method",
    repoName: symbol.repoName,
    moduleName: symbol.module,
    modulePath: symbol.modulePath,
    packageName: symbol.packageName,
    symbolName: `${symbol.fqn}#${method.name}`,
    fqn: `${symbol.fqn}#${method.name}`,
    summary: method.signature,
    metadata,
    embeddingText,
  };
}

function prepareRow(
  entry: IndexEntry,
  embedding: number[],
  vectorField: string,
) {
  return {
    id: entry.id,
    index_level: entry.level,
    repo_name: entry.repoName,
    module_name: entry.moduleName ?? "",
    module_path: entry.modulePath ?? "",
    package_name: entry.packageName ?? "",
    symbol_name: entry.symbolName ?? "",
    fqn: entry.fqn ?? entry.symbolName ?? entry.repoName,
    summary: entry.summary.slice(0, 2000),
    metadata: JSON.stringify(entry.metadata).slice(0, 8000),
    [vectorField]: embedding,
  };
}

async function run() {
  const config = loadConfig();
  const initial = await loadInitialSymbols(config);
  let records = applyEnvFilters(initial.records);
  const ingestLimit = process.env.INGEST_LIMIT
    ? Number(process.env.INGEST_LIMIT)
    : undefined;
  if (ingestLimit && Number.isFinite(ingestLimit) && ingestLimit > 0) {
    records = records.slice(0, ingestLimit);
    console.log(
      `INGEST_LIMIT set to ${ingestLimit}, truncating records to ${records.length}.`,
    );
  }
  if (initial.source === "psi-cache") {
    console.log(
      `Loaded ${records.length} symbols from PSI cache: ${config.psiCachePath}`,
    );
  } else {
    console.log("Building symbols from project:", config.projectRoot);
  }
  if (records.length === 0) {
    throw new Error("No symbols found to ingest");
  }

  const entries = buildIndexEntries(records);
  const embeddedRows: Array<ReturnType<typeof prepareRow>> = [];
  let dimension: number | undefined;
  let fallbackCount = 0;
  const totalEntries = entries.length;
  const embedLogEvery = Number(process.env.EMBED_LOG_EVERY ?? 200);
  console.log(
    `[idea-bridge] Embedding ${totalEntries} entries (provider=${config.embeddingProvider}, model=${config.embeddingModel}, host=${config.embeddingHost})...`,
  );
  function resizeExistingRows(targetDimension: number) {
    for (const row of embeddedRows) {
      const vector = row[config.milvusVectorField];
      if (Array.isArray(vector)) {
        row[config.milvusVectorField] = adjustVectorLength(vector, targetDimension);
      }
    }
  }

  for (const entry of entries) {
    const prompt = entry.embeddingText;
    let embedding: number[];
    const desiredDimension =
      dimension ??
      (config.embeddingProvider === "jina"
        ? 1024
        : config.embeddingProvider === "ollama"
          ? 768
          : 768);
    try {
      embedding = await generateEmbedding(
        prompt,
        config.embeddingModel,
        config.embeddingHost,
        config.embeddingProvider,
        config.embeddingTaskPassage,
      );
    } catch (error) {
      console.warn(
        `[idea-bridge] embedding failed for ${entry.id}, using fallback`,
        error instanceof Error ? error.message : error,
      );
      embedding = fallbackEmbedding(prompt, desiredDimension);
      fallbackCount += 1;
    }

    if (!dimension) {
      dimension = embedding.length;
    } else if (embedding.length !== dimension) {
      if (embedding.length > dimension) {
        dimension = embedding.length;
        resizeExistingRows(dimension);
      }
      embedding = adjustVectorLength(embedding, dimension);
    }

    // Skip zero-norm vectors to avoid polluting Milvus with unusable rows
    if (vectorNorm(embedding) === 0) {
      console.warn(`Skipping zero-norm embedding for ${entry.id}`);
      continue;
    }

    embeddedRows.push(prepareRow(entry, embedding, config.milvusVectorField));
    if (embeddedRows.length % embedLogEvery === 0 || embeddedRows.length === totalEntries) {
      console.log(
        `[idea-bridge] embedded ${embeddedRows.length}/${totalEntries} (fallbacks=${fallbackCount})`,
      );
    }
  }

  if (fallbackCount > 0) {
    console.warn(
      `[idea-bridge] total fallback embeddings: ${fallbackCount}/${embeddedRows.length}`,
    );
  }

  const vectorLength = embeddedRows[0]?.[config.milvusVectorField]?.length;
  const finalDimension = vectorLength ?? dimension;

  if (!finalDimension) {
    throw new Error("Unable to determine embedding dimension");
  }

  const hist = new Map<number, number>();
  for (const row of embeddedRows) {
    const vec = row[config.milvusVectorField];
    if (Array.isArray(vec)) {
      const len = vec.length;
      hist.set(len, (hist.get(len) ?? 0) + 1);
      if (len !== finalDimension) {
        row[config.milvusVectorField] = adjustVectorLength(vec, finalDimension);
      }
    }
  }
  if (hist.size > 1) {
    console.warn("[idea-bridge] vector length histogram", Object.fromEntries(hist));
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-bridge-"));
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/milvus_ingest.py",
  );

  if (process.env.DISABLE_MILVUS === "1" || process.env.MILVUS_DRY_RUN === "1") {
    const payload = {
      collectionName: config.milvusCollection,
      vectorField: config.milvusVectorField,
      dimension: finalDimension,
      reset: config.resetMilvusCollection,
      milvusAddress: config.milvusGrpcAddress,
      milvusDatabase: config.milvusDatabase,
      rows: embeddedRows,
    };
    const jsonPath = path.join(tmpDir, "symbols.json");
    await fs.writeFile(jsonPath, JSON.stringify(payload));
    console.log(
      "[idea-bridge] Milvus ingestion skipped because DISABLE_MILVUS/MILVUS_DRY_RUN is set.",
    );
    console.log(
      `[idea-bridge] Sample payload row: ${JSON.stringify(
        payload.rows[0],
        null,
        2,
      ).slice(0, 2000)}...`,
    );
    await fs.rm(tmpDir, { recursive: true, force: true });
    console.log(
      `[idea-bridge] Wrote payload for inspection at ${jsonPath} (deleted after dry-run).`,
    );
    console.log(
      "[idea-bridge] To ingest into Milvus, rerun npm run ingest:milvus without DISABLE_MILVUS.",
    );
    return;
  }

  // Chunked ingest to avoid huge JSON payloads.
  const chunkSize = Number(process.env.INGEST_CHUNK_SIZE ?? 2000);
  let inserted = 0;
  console.log(
    `[idea-bridge] Ingesting ${embeddedRows.length} rows in chunks of ${chunkSize} (dim=${finalDimension})...`,
  );
  for (let start = 0; start < embeddedRows.length; start += chunkSize) {
    const chunkIndex = Math.floor(start / chunkSize) + 1;
    const totalChunks = Math.ceil(embeddedRows.length / chunkSize);
    const rows = embeddedRows.slice(start, start + chunkSize);
    const end = start + rows.length;
    console.log(
      `[idea-bridge] chunk ${chunkIndex}/${totalChunks} rows ${start}-${end} (reset=${config.resetMilvusCollection && start === 0})`,
    );
    const payload = {
      collectionName: config.milvusCollection,
      vectorField: config.milvusVectorField,
      dimension: finalDimension,
      reset: config.resetMilvusCollection && start === 0,
      milvusAddress: config.milvusGrpcAddress,
      milvusDatabase: config.milvusDatabase,
      rows,
    };
    const jsonPath = path.join(tmpDir, `symbols-${start}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(payload));

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("python3", [scriptPath, jsonPath], {
        stdio: "inherit",
      });
      proc.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Python ingestor exited with code ${code}`));
      });
      proc.on("error", (error) => reject(error));
    });
    inserted += rows.length;
    console.log(
      `[idea-bridge] inserted so far: ${inserted}/${embeddedRows.length}`,
    );
  }

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(`Ingestion complete. Total entries: ${inserted}`);
}

run().catch((error) => {
  console.error("Failed to ingest symbols into Milvus:", error);
  process.exitCode = 1;
});

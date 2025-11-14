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
import { buildSymbolRecords } from "../indexer.js";
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
  }));

  const metadata = {
    moduleCount: modules.size,
    classCount,
    modules: truncateArray(moduleSummaries, 12),
  };

  const embeddingText = [
    `Repository ${repoName}`,
    `Modules: ${modules.size}`,
    `Total classes: ${classCount}`,
    ...truncateArray(moduleSummaries, 8).map(
      (m) => `Module ${m.module} (${m.classCount} classes)`,
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
  for (const cls of module.classes) {
    cls.dependencies.imports.forEach((dep) => dependencies.add(dep));
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
  };

  const embeddingText = [
    `Module ${module.moduleName} in repo ${repoName}`,
    `Path: ${module.modulePath}`,
    `Packages: ${Array.from(packages).join(", ")}`,
    `Classes: ${module.classes.length}`,
    `Spring beans: ${springBeans.length}`,
    `Dependencies: ${Array.from(dependencies).join(", ")}`,
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
  const metadata = {
    class: symbol.fqn,
    module: symbol.module,
    parameters: method.parameters,
    returnType: method.returnTypeFqn ?? method.returnType,
    annotations: method.annotations?.map((ann) => ann.fqn ?? ann.name),
    visibility: method.visibility,
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
  console.log("Building symbols from project:", config.projectRoot);
  const records = await buildSymbolRecords({ projectRoot: config.projectRoot });
  if (records.length === 0) {
    throw new Error("No symbols found to ingest");
  }

  const entries = buildIndexEntries(records);
  const embeddedRows: Array<ReturnType<typeof prepareRow>> = [];
  let dimension: number | undefined;
  let fallbackCount = 0;
  for (const entry of entries) {
    const prompt = entry.embeddingText;
    let embedding: number[];
    try {
      embedding = await generateEmbedding(
        prompt,
        config.embeddingModel,
        config.embeddingHost,
      );
    } catch (error) {
      console.warn(
        `[idea-bridge] embedding failed for ${entry.id}, using fallback`,
        error instanceof Error ? error.message : error,
      );
      embedding = fallbackEmbedding(prompt, dimension ?? 384);
      fallbackCount += 1;
    }

    if (!dimension) {
      dimension = embedding.length;
    } else if (embedding.length !== dimension) {
      embedding = adjustVectorLength(embedding, dimension);
    }

    embeddedRows.push(prepareRow(entry, embedding, config.milvusVectorField));
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

  const payload = {
    collectionName: config.milvusCollection,
    vectorField: config.milvusVectorField,
    dimension: finalDimension,
    reset: config.resetMilvusCollection,
    milvusAddress: config.milvusGrpcAddress,
    milvusDatabase: config.milvusDatabase,
    rows: embeddedRows,
  };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-bridge-"));
  const jsonPath = path.join(tmpDir, "symbols.json");
  await fs.writeFile(jsonPath, JSON.stringify(payload));

  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/milvus_ingest.py",
  );

  console.log("Handing off to Python ingestor...");
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

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(`Ingestion complete. Total entries: ${embeddedRows.length}`);
}

run().catch((error) => {
  console.error("Failed to ingest symbols into Milvus:", error);
  process.exitCode = 1;
});

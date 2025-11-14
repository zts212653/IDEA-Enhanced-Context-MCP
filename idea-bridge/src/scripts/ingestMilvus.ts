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
import type { SymbolRecord } from "../types.js";

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

function prepareRow(symbol: SymbolRecord, embedding: number[], vectorField: string) {
  return {
    id: symbol.fqn,
    module: symbol.module,
    packageName: symbol.packageName,
    summary: symbol.summary.slice(0, 2000),
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

  const embeddedRows: Array<ReturnType<typeof prepareRow>> = [];
  let dimension: number | undefined;
  let fallbackCount = 0;
  for (const symbol of records) {
    const prompt = symbolToEmbeddingText(symbol);
    let embedding: number[];
    try {
      embedding = await generateEmbedding(
        prompt,
        config.embeddingModel,
        config.embeddingHost,
      );
    } catch (error) {
      console.warn(
        `[idea-bridge] embedding failed for ${symbol.fqn}, using fallback`,
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

    embeddedRows.push(prepareRow(symbol, embedding, config.milvusVectorField));
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
  console.log(`Ingestion complete. Total symbols: ${embeddedRows.length}`);
}

run().catch((error) => {
  console.error("Failed to ingest symbols into Milvus:", error);
  process.exitCode = 1;
});

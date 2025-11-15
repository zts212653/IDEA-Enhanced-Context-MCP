import fs from "node:fs/promises";
import path from "node:path";

import type { SymbolRecord, UploadMetadata } from "./types.js";

interface BatchMeta {
  schemaVersion: number;
  projectName?: string;
  generatedAt?: string;
  batchId: number;
  totalBatches: number;
}

interface UploadSession {
  schemaVersion: number;
  projectName?: string;
  generatedAt?: string;
  totalBatches: number;
  receivedBatches: number;
  records: SymbolRecord[];
  startedAt: string;
}

type BatchResult =
  | {
      ready: false;
      receivedBatches: number;
      totalBatches: number;
    }
  | {
      ready: true;
      combinedRecords: SymbolRecord[];
      uploadMeta: UploadMetadata;
    };

let session: UploadSession | undefined;

export function resetUploadSession() {
  session = undefined;
}

export function ingestUploadBatch(
  meta: BatchMeta,
  batchRecords: SymbolRecord[],
): BatchResult {
  const totalBatches = Math.max(1, meta.totalBatches || 1);
  const batchId = Math.max(1, meta.batchId || 1);

  if (totalBatches <= 1) {
    const uploadMeta = buildUploadMeta(meta, totalBatches);
    return {
      ready: true,
      combinedRecords: batchRecords,
      uploadMeta,
    };
  }

  if (!session || batchId === 1) {
    session = {
      schemaVersion: meta.schemaVersion,
      projectName: meta.projectName,
      generatedAt: meta.generatedAt,
      totalBatches,
      receivedBatches: 0,
      records: [],
      startedAt: new Date().toISOString(),
    };
  } else if (
    session.schemaVersion !== meta.schemaVersion ||
    session.projectName !== meta.projectName ||
    session.totalBatches !== totalBatches
  ) {
    throw new Error(
      "Upload batch metadata mismatch; start a new export before continuing.",
    );
  }

  session.records.push(...batchRecords);
  session.receivedBatches += 1;

  if (session.receivedBatches >= session.totalBatches) {
    const uploadMeta = buildUploadMeta(
      {
        schemaVersion: session.schemaVersion,
        projectName: session.projectName,
        generatedAt: session.generatedAt,
        batchId,
        totalBatches: session.totalBatches,
      },
      session.totalBatches,
    );
    const combined = session.records.slice();
    session = undefined;
    return {
      ready: true,
      combinedRecords: combined,
      uploadMeta,
    };
  }

  return {
    ready: false,
    receivedBatches: session.receivedBatches,
    totalBatches: session.totalBatches,
  };
}

function buildUploadMeta(
  meta: BatchMeta,
  batchCount: number,
): UploadMetadata {
  return {
    schemaVersion: meta.schemaVersion,
    projectName: meta.projectName,
    generatedAt: meta.generatedAt,
    batchCount,
    uploadedAt: new Date().toISOString(),
  };
}

export async function appendUploadLog(
  logPath: string,
  entry: Record<string, unknown>,
) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

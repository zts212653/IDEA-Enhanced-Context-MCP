import Fastify from "fastify";
import path from "node:path";

import { loadConfig } from "./config.js";
import { SymbolIndex } from "./indexer.js";
import { loadInitialSymbols } from "./psiDataSource.js";
import { savePsiCache } from "./psiCache.js";
import {
  appendUploadLog,
  ingestUploadBatch,
  resetUploadSession,
} from "./uploadSession.js";
import type { SymbolRecord } from "./types.js";

const DEFAULT_SCHEMA_VERSION = 2;

function slugify(value?: string | null): string {
  if (!value) return "default";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .trim() || "default";
}

function deriveCachePath(config: ReturnType<typeof loadConfig>, projectName?: string | null) {
  const baseDir =
    config.psiCacheDir ??
    path.dirname(config.psiCachePath);
  const isDefaultName = path.basename(config.psiCachePath) === "psi-cache.json";
  if (projectName && baseDir) {
    return path.join(baseDir, `psi-cache-${slugify(projectName)}.json`);
  }
  if (isDefaultName && baseDir) {
    return path.join(baseDir, "psi-cache-default.json");
  }
  return config.psiCachePath;
}

async function bootstrap() {
  const config = loadConfig();
  const bodyLimit = Number(
    process.env.BRIDGE_BODY_LIMIT ?? 50 * 1024 * 1024,
  );
  const fastify = Fastify({
    logger: true,
    bodyLimit,
  });

  const initialLoad = await loadInitialSymbols(config, fastify.log);
  let currentCachePath = initialLoad.cachePath ?? config.psiCachePath;
  let records: SymbolRecord[] = initialLoad.records;
  let dataSource: "psi-cache" | "regex" = initialLoad.source;
  let index = new SymbolIndex(records);
  const uploadLogPath = path.join(
    path.dirname(config.psiCachePath),
    "upload-log.ndjson",
  );

  function replaceRecords(newRecords: SymbolRecord[]) {
    records = newRecords;
    index = new SymbolIndex(records);
    dataSource = "psi-cache";
    fastify.log.info(
      { count: records.length },
      "symbol index reloaded via PSI upload",
    );
  }

  fastify.get("/healthz", async () => ({ status: "ok" }));
  fastify.get("/api/info", async () => ({
    projectRoot: config.projectRoot,
    symbolCount: records.length,
    dataSource,
    psiCachePath: currentCachePath,
  }));

  fastify.post("/api/psi/upload", async (request, reply) => {
    const body = request.body as {
      symbols?: SymbolRecord[];
      schemaVersion?: number;
      generatedAt?: string;
      projectName?: string;
      batchId?: number;
      totalBatches?: number;
    } | null;
    if (!body || !Array.isArray(body.symbols) || body.symbols.length === 0) {
      reply.code(400);
      return { error: "payload must contain a non-empty symbols array" };
    }

    const sanitized = body.symbols.filter(
      (symbol) =>
        typeof symbol?.fqn === "string" && typeof symbol?.summary === "string",
    );

    if (sanitized.length === 0) {
      reply.code(400);
      return { error: "no valid symbol records found" };
    }

    const meta = {
      schemaVersion: Number(body.schemaVersion ?? DEFAULT_SCHEMA_VERSION),
      generatedAt: body.generatedAt ?? new Date().toISOString(),
      projectName: body.projectName,
      batchId: Number(body.batchId ?? 1),
      totalBatches: Number(body.totalBatches ?? 1),
    };

    let batchResult;
    try {
      batchResult = ingestUploadBatch(meta, sanitized);
    } catch (error) {
      resetUploadSession();
      reply.code(409);
      return { error: error instanceof Error ? error.message : String(error) };
    }

    await appendUploadLog(uploadLogPath, {
      timestamp: new Date().toISOString(),
      schemaVersion: meta.schemaVersion,
      projectName: meta.projectName ?? null,
      batchId: meta.batchId,
      totalBatches: meta.totalBatches,
      acceptedSymbols: sanitized.length,
      ready: batchResult.ready,
    });

    if (!batchResult.ready) {
      return {
        accepted: sanitized.length,
        batchId: meta.batchId,
        totalBatches: meta.totalBatches,
        receivedBatches: batchResult.receivedBatches,
      };
    }

    const annotated = batchResult.combinedRecords.map((symbol) => ({
      ...symbol,
      uploadMeta: batchResult.uploadMeta,
      source: "psi-cache" as const,
    }));

    replaceRecords(annotated);
    try {
      currentCachePath = deriveCachePath(config, meta.projectName);
      await savePsiCache(currentCachePath, {
        schemaVersion: batchResult.uploadMeta.schemaVersion,
        generatedAt:
          batchResult.uploadMeta.generatedAt ?? batchResult.uploadMeta.uploadedAt,
        projectName: batchResult.uploadMeta.projectName,
        symbols: annotated,
      });
    } catch (error) {
      fastify.log.warn(
        { err: error },
        "failed to persist PSI cache after upload",
      );
    }

    return {
      updated: annotated.length,
      uploadMeta: batchResult.uploadMeta,
    };
  });

  fastify.get("/api/symbols/search", async (request, reply) => {
    const { query, limit, module } = request.query as {
      query?: string;
      limit?: string;
      module?: string;
    };

    if (!query) {
      reply.code(400);
      return { error: "query param is required" };
    }

    const searchResults = index.search({
      query,
      limit: limit ? Number(limit) : undefined,
      module,
    });
    const results = searchResults.map((record) => {
      const recordSource: "psi-cache" | "regex" = record.uploadMeta
        ? "psi-cache"
        : dataSource;
      return { ...record, source: recordSource };
    });

    return {
      query,
      limit: limit ? Number(limit) : undefined,
      module,
      total: results.length,
      dataSource,
      results,
    };
  });

  fastify.get("/api/symbols/:fqn", async (request, reply) => {
    const { fqn } = request.params as { fqn: string };
    const record = records.find((item) => item.fqn === fqn);
    if (!record) {
      reply.code(404);
      return { error: "symbol not found" };
    }
    return record;
  });

  const host = process.env.BRIDGE_HOST ?? "127.0.0.1";
  const address = await fastify.listen({ port: config.port, host });
  fastify.log.info(`IDEA Bridge mock server listening at ${address}`);
}

bootstrap().catch((error) => {
  console.error("Failed to start bridge server:", error);
  process.exitCode = 1;
});

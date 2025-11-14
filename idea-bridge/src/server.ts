import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { buildSymbolRecords, SymbolIndex } from "./indexer.js";
import type { SymbolRecord } from "./types.js";

async function bootstrap() {
  const config = loadConfig();
  const fastify = Fastify({ logger: true });

  fastify.log.info(
    { projectRoot: config.projectRoot },
    "building symbol index...",
  );
  let records = await buildSymbolRecords({ projectRoot: config.projectRoot });
  let index = new SymbolIndex(records);

  function replaceRecords(newRecords: SymbolRecord[]) {
    records = newRecords;
    index = new SymbolIndex(records);
    fastify.log.info(
      { count: records.length },
      "symbol index reloaded via PSI upload",
    );
  }

  fastify.get("/healthz", async () => ({ status: "ok" }));
  fastify.get("/api/info", async () => ({
    projectRoot: config.projectRoot,
    symbolCount: records.length,
  }));

  fastify.post("/api/psi/upload", async (request, reply) => {
    const body = request.body as { symbols?: SymbolRecord[] } | undefined;
    if (!body || !Array.isArray(body.symbols) || body.symbols.length === 0) {
      reply.code(400);
      return { error: "payload must contain a non-empty symbols array" };
    }

    const sanitized = body.symbols.filter((symbol) =>
      typeof symbol?.fqn === "string" && typeof symbol?.summary === "string",
    );

    if (sanitized.length === 0) {
      reply.code(400);
      return { error: "no valid symbol records found" };
    }

    replaceRecords(sanitized);
    return { updated: sanitized.length };
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

    const results = index.search({
      query,
      limit: limit ? Number(limit) : undefined,
      module,
    });

    return {
      query,
      limit: limit ? Number(limit) : undefined,
      module,
      total: results.length,
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

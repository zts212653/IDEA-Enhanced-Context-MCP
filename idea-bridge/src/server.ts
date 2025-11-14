import Fastify from "fastify";

import { loadConfig } from "./config.js";
import { buildSymbolRecords, SymbolIndex } from "./indexer.js";

async function bootstrap() {
  const config = loadConfig();
  const fastify = Fastify({ logger: true });

  fastify.log.info(
    { projectRoot: config.projectRoot },
    "building symbol index...",
  );
  const records = await buildSymbolRecords({ projectRoot: config.projectRoot });
  const index = new SymbolIndex(records);

  fastify.get("/healthz", async () => ({ status: "ok" }));
  fastify.get("/api/info", async () => ({
    projectRoot: config.projectRoot,
    symbolCount: records.length,
  }));

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

  const address = await fastify.listen({ port: config.port, host: "0.0.0.0" });
  fastify.log.info(`IDEA Bridge mock server listening at ${address}`);
}

bootstrap().catch((error) => {
  console.error("Failed to start bridge server:", error);
  process.exitCode = 1;
});

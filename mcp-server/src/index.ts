import net from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createIdeaBridgeClient } from "./bridgeClient.js";
import { createMilvusSearchClient } from "./milvusClient.js";
import {
  createSearchPipeline,
  type MilvusSearchHandle,
  estimateTokens,
} from "./searchPipeline.js";
import { createFixtureRegistry } from "./fixtureRegistry.js";
import type {
  SymbolRecord,
  SearchHit,
  RelationInfo,
  HierarchyInfo,
  SpringInfo,
  UploadInfo,
} from "./types.js";

const log = (...args: unknown[]) => console.error("[idea-mcp]", ...args);

type BridgeHealth = {
  url: string | null;
  reachable: boolean;
  status: string | null;
  symbolCount: number | null;
  dataSource: string | null;
  psiCachePath: string | null;
};

type MilvusHealth = {
  address: string | null;
  reachable: boolean;
  message: string | null;
};

async function fetchWithTimeout(url: string, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkBridgeHealth(baseUrl: string | null | undefined): Promise<BridgeHealth> {
  if (!baseUrl) {
    return {
      url: null,
      reachable: false,
      status: "IDEA_BRIDGE_URL not set",
      symbolCount: null,
      dataSource: null,
      psiCachePath: null,
    };
  }

  try {
    const healthResp = await fetchWithTimeout(new URL("/healthz", baseUrl).toString());
    if (!healthResp.ok) {
      return {
        url: baseUrl,
        reachable: false,
        status: `HTTP ${healthResp.status}`,
        symbolCount: null,
        dataSource: null,
        psiCachePath: null,
      };
    }

    let info: Record<string, unknown> | undefined;
    try {
      const infoResp = await fetchWithTimeout(new URL("/api/info", baseUrl).toString());
      if (infoResp.ok) {
        info = (await infoResp.json()) as Record<string, unknown>;
      }
    } catch (error) {
      log("bridge info fetch failed", error);
    }

    return {
      url: baseUrl,
      reachable: true,
      status: "ok",
      symbolCount: typeof info?.symbolCount === "number" ? (info!.symbolCount as number) : null,
      dataSource: (info?.dataSource as string) ?? null,
      psiCachePath: (info?.psiCachePath as string) ?? null,
    };
  } catch (error) {
    return {
      url: baseUrl,
      reachable: false,
      status: error instanceof Error ? error.message : String(error),
      symbolCount: null,
      dataSource: null,
      psiCachePath: null,
    };
  }
}

async function checkMilvusHealth(address: string | null | undefined): Promise<MilvusHealth> {
  if (!address) {
    return {
      address: null,
      reachable: false,
      message: "MILVUS_ADDRESS not set",
    };
  }

  const [host, portPart] = address.split(":");
  const port = Number(portPart ?? "19530");
  return await new Promise<MilvusHealth>((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.end();
      resolve({ address, reachable: true, message: null });
    });
    socket.setTimeout(2000, () => {
      socket.destroy(new Error("timeout"));
    });
    socket.on("error", (err) => {
      resolve({ address, reachable: false, message: err.message });
    });
    socket.on("close", () => {
      /* no-op */
    });
  });
}

const mockSymbols: SymbolRecord[] = [
  {
    fqn: "com.example.auth.UserService",
    kind: "INTERFACE",
    module: "auth-service",
    summary: "User lookup & lifecycle operations (source of truth).",
    scoreHints: { references: 52, lastModifiedDays: 11 },
  },
  {
    fqn: "com.example.auth.impl.UserServiceImpl",
    kind: "CLASS",
    module: "auth-service",
    summary:
      "SQL-backed implementation of UserService, handles password hashing.",
    scoreHints: { references: 41, lastModifiedDays: 3 },
  },
  {
    fqn: "com.example.billing.InvoiceService",
    kind: "INTERFACE",
    module: "billing-service",
    summary: "Invoice creation + payment capture orchestration entrypoint.",
    scoreHints: { references: 28, lastModifiedDays: 40 },
  },
  {
    fqn: "com.example.billing.InvoiceServiceImpl",
    kind: "CLASS",
    module: "billing-service",
    summary: "Implements InvoiceService with CQRS pipeline integration.",
    scoreHints: { references: 18, lastModifiedDays: 15 },
  },
  {
    fqn: "com.example.auth.UserServiceImpl.findById",
    kind: "METHOD",
    module: "auth-service",
    summary:
      "Primary lookup by userId; wraps repository to enforce tenant scoping.",
    scoreHints: { references: 64, lastModifiedDays: 3 },
  },
];

const searchArgsSchema = z.object({
  query: z
    .string({
      required_error: "query is required",
      invalid_type_error: "query must be a string",
    })
    .min(1, "query cannot be empty"),
  limit: z
    .number({
      invalid_type_error: "limit must be a number",
    })
    .int("limit must be an integer")
    .min(1, "limit must be >= 1")
    .max(20, "limit must be <= 20")
    .optional(),
  moduleFilter: z
    .string({
      invalid_type_error: "moduleFilter must be a string",
    })
    .min(1, "moduleFilter cannot be empty")
    .optional(),
  moduleHint: z
    .string({
      invalid_type_error: "moduleHint must be a string",
    })
    .min(1, "moduleHint cannot be empty")
    .optional(),
  preferredLevels: z
    .array(z.enum(["module", "class", "method"]))
    .max(3)
    .optional(),
  maxContextTokens: z
    .number({
      invalid_type_error: "maxContextTokens must be a number",
    })
    .int("maxContextTokens must be an integer")
    .min(1000, "maxContextTokens must be >= 1000")
    .max(20000, "maxContextTokens must be <= 20000")
    .optional(),
  scenarioId: z
    .string({ invalid_type_error: "scenarioId must be a string" })
    .min(1, "scenarioId cannot be empty")
    .optional(),
});

type SearchToolArguments = z.infer<typeof searchArgsSchema>;

const ideaBridgeClient = createIdeaBridgeClient();
const milvusClientHandle = createMilvusSearchClient();
const useFixture =
  process.env.CI_FIXTURE === "1" || process.env.MCP_EVAL_FIXTURE === "1";
const fixtureRegistry = createFixtureRegistry(useFixture);

const milvusSearchHandle: MilvusSearchHandle | undefined = milvusClientHandle;

const searchPipeline = createSearchPipeline({
  bridgeClient: ideaBridgeClient,
  milvusClient: milvusSearchHandle,
  fallbackSymbols: mockSymbols,
  fixtureRegistry,
});

const bridgeHealthSchema = z.object({
  url: z.string().nullable(),
  reachable: z.boolean(),
  status: z.string().nullable(),
  symbolCount: z.number().nullable(),
  dataSource: z.string().nullable(),
  psiCachePath: z.string().nullable(),
});

const milvusHealthSchema = z.object({
  address: z.string().nullable(),
  reachable: z.boolean(),
  message: z.string().nullable(),
});

const server = new McpServer(
  {
    name: "idea-enhanced-context",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
    instructions:
      "Performs staged semantic search backed by IntelliJ PSI uploads (bridge) and Milvus embeddings. Query modules/classes/methods and review module hits separately before final context delivery.",
  },
);

server.registerTool(
  "health_check",
  {
    title: "Health check",
    description:
      "Report bridge and Milvus environment values to verify MCP wiring.",
    inputSchema: z.object({}).describe("No input required."),
    outputSchema: z.object({
      ok: z.boolean(),
      bridge: bridgeHealthSchema,
      milvus: milvusHealthSchema,
    }),
  },
  async () => {
    const bridgeUrl =
      process.env.IDEA_BRIDGE_URL ??
      process.env.IDEA_BRIDGE_BASE_URL ??
      process.env.IDEA_BRIDGE_HTTP ??
      null;
    const milvusAddress = process.env.MILVUS_ADDRESS ?? null;
    const bridge = await checkBridgeHealth(bridgeUrl);
    const milvus = await checkMilvusHealth(milvusAddress);
    const ok = bridge.reachable && milvus.reachable;
    return {
      content: [
        {
          type: "text",
          text: `Bridge: ${bridge.status ?? "unknown"} (url: ${bridge.url ?? "n/a"})\nMilvus: ${milvus.message ?? "ok"} (address: ${milvus.address ?? "n/a"})`,
        },
      ],
      structuredContent: {
        ok,
        bridge,
        milvus,
      },
    };
  },
);

const relationInfoSchema = z
  .object({
    calls: z.array(z.string()).optional(),
    calledBy: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
  })
  .partial();

const hierarchyInfoSchema = z
  .object({
    superClass: z.string().nullable().optional(),
    interfaces: z.array(z.string()).optional(),
  })
  .partial();

const springInfoSchema = z
  .object({
    isSpringBean: z.boolean().optional(),
    beanType: z.string().nullable().optional(),
    beanName: z.string().nullable().optional(),
    autoWiredDependencies: z.array(z.string()).optional(),
    annotations: z.array(z.string()).optional(),
  })
  .partial();

const uploadInfoSchema = z
  .object({
    schemaVersion: z.number().optional(),
    projectName: z.string().nullable().optional(),
    generatedAt: z.string().nullable().optional(),
    uploadedAt: z.string().nullable().optional(),
    batchCount: z.number().nullable().optional(),
  })
  .partial();

const locationSchema = z
  .object({
    repoName: z.string().nullable().optional(),
    module: z.string().nullable().optional(),
    modulePath: z.string().nullable().optional(),
    packageName: z.string().nullable().optional(),
    filePath: z.string().nullable().optional(),
  })
  .partial();

const symbolSourceSchema = z.enum(["psi-cache", "regex"]).optional();

const hitSchema = z.object({
  fqn: z.string(),
  kind: z.enum(["CLASS", "INTERFACE", "METHOD", "MODULE", "REPOSITORY"]),
  module: z.string(),
  repoName: z.string().nullable().optional(),
  modulePath: z.string().nullable().optional(),
  packageName: z.string().nullable().optional(),
  indexLevel: z.string().nullable().optional(),
  summary: z.string(),
  score: z.number().min(0).max(1).optional(),
  relations: relationInfoSchema.optional(),
  hierarchy: hierarchyInfoSchema.optional(),
  springInfo: springInfoSchema.optional(),
  uploadInfo: uploadInfoSchema.optional(),
  source: symbolSourceSchema,
  metadata: z.record(z.any()).optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
  location: locationSchema.optional(),
  scoreHints: z
    .object({
      references: z.number().int().nonnegative().optional(),
      lastModifiedDays: z.number().int().nonnegative().optional(),
    })
    .partial()
    .optional(),
});

const moduleStatsSchema = z
  .object({
    classCount: z.number().optional(),
    packageCount: z.number().optional(),
    springBeans: z.number().optional(),
    topPackages: z.array(z.string()).optional(),
    sampleDependencies: z.array(z.string()).optional(),
    relationSummary: z.record(z.any()).optional(),
  })
  .partial();

const moduleCandidateSchema = hitSchema.extend({
  stats: moduleStatsSchema.optional(),
});

const deliveredResultSchema = hitSchema.extend({
  context: z
    .object({
      dependencies: z.any().optional(),
      quality: z.any().optional(),
    })
    .optional(),
});

const stageSummarySchema = z.object({
  name: z.enum(["bridge", "milvus-module", "milvus-class", "milvus-method", "fallback"]),
  hitCount: z.number().int().nonnegative(),
  kinds: z.array(z.string()).optional(),
  levels: z.array(z.string()).optional(),
});

const searchResultSchema = z.object({
  query: z.string(),
  requestedLimit: z.number().int().min(1).max(20),
  moduleFilter: z.string().nullable(),
  moduleHint: z.string().nullable(),
  preferredLevels: z.array(z.enum(["module", "class", "method"])).optional(),
  fallbackUsed: z.boolean(),
  totalCandidates: z.number().int().min(0),
  deliveredCount: z.number().int().min(0),
  omittedCount: z.number().int().min(0),
  stages: z.array(stageSummarySchema),
  moduleCandidates: z.array(moduleCandidateSchema),
  deliveredResults: z.array(deliveredResultSchema),
  budget: z.object({
    tokenLimit: z.number().int().positive(),
    usedTokens: z.number().int().nonnegative(),
  }),
  contextBudget: z.object({
    maxTokens: z.number().int().positive(),
    usedTokens: z.number().int().nonnegative(),
    omittedCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
    debug: z.object({
      strategy: z.object({
        profile: z.string(),
        reason: z.string(),
        preferredLevels: z.array(z.string()),
        moduleLimit: z.number().int().nonnegative(),
        classLimit: z.number().int().nonnegative(),
        methodLimit: z.number().int().nonnegative(),
        moduleFilter: z.string().nullable(),
        moduleHint: z.string().nullable(),
        scenario: z.string().nullable().optional(),
        profileId: z.string().optional(),
      }),
    }),
});

function toStringArray(value: unknown, limit = 8): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry))
      .filter((entry) => entry.length > 0)
      .slice(0, limit);
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return undefined;
}

function pickString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function describeHit(hit: SearchHit) {
  const metadata = (hit.metadata ?? {}) as Record<string, unknown>;
  const estimatedTokens = estimateTokens(hit);
  const repoName =
    hit.repoName ?? pickString(metadata, "repoName") ?? pickString(metadata, "repo_name");
  const modulePath =
    hit.modulePath ?? pickString(metadata, "modulePath") ?? pickString(metadata, "module_path");
  const packageName =
    hit.packageName ??
    pickString(metadata, "packageName") ??
    pickString(metadata, "package");
  const filePath =
    pickString(metadata, "filePath") ?? pickString(metadata, "relativePath");
  const hierarchy =
    hit.hierarchy ??
    ((metadata.hierarchy as HierarchyInfo | undefined) ??
      (metadata.hierarchySummary as HierarchyInfo | undefined));
  const relations =
    hit.relations ?? (metadata.relations as RelationInfo | undefined);
  const springInfo =
    hit.springInfo ??
    ((metadata.spring as SpringInfo | undefined) ??
      (metadata.springInfo as SpringInfo | undefined));
  const uploadInfo =
    hit.uploadInfo ??
    ((metadata.upload as UploadInfo | undefined) ??
      (metadata.uploadMeta as UploadInfo | undefined));
  const source =
    hit.source ??
    ((metadata.source as "psi-cache" | "regex" | undefined) ??
      (uploadInfo ? "psi-cache" : "regex"));

  return {
    fqn: hit.fqn,
    kind: hit.kind,
    repoName,
    module: hit.module,
    modulePath,
    packageName,
    summary: hit.summary,
    indexLevel: hit.indexLevel,
    score: hit.score,
    relations,
    hierarchy,
    springInfo,
    uploadInfo,
    source,
    metadata,
    estimatedTokens,
    location: {
      repoName,
      module: hit.module,
      modulePath,
      packageName,
      filePath,
    },
  };
}

function describeModuleCandidate(hit: SearchHit) {
  const base = describeHit(hit);
  const metadata = base.metadata ?? {};
  const stats = {
    classCount:
      typeof metadata.classCount === "number"
        ? metadata.classCount
        : typeof metadata.classes === "number"
        ? metadata.classes
        : undefined,
    packageCount:
      typeof metadata.packageCount === "number"
        ? metadata.packageCount
        : undefined,
    springBeans:
      typeof metadata.springBeans === "number"
        ? metadata.springBeans
        : undefined,
    topPackages: toStringArray(metadata.packages),
    sampleDependencies: toStringArray(metadata.dependencies),
    relationSummary: metadata.relationSummary,
  };
  return {
    ...base,
    stats:
      Object.values(stats).some((value) =>
        Array.isArray(value) ? value.length > 0 : value !== undefined,
      )
        ? stats
        : undefined,
  };
}

function describeDeliveredHit(hit: SearchHit) {
  const base = describeHit(hit);
  const metadata = base.metadata ?? {};
  const context = {
    dependencies: metadata.dependencies,
    quality: metadata.quality,
  };
  const hasContext =
    context.dependencies !== undefined || context.quality !== undefined;
  return {
    ...base,
    context: hasContext ? context : undefined,
  };
}

const searchToolDefinition = {
  title: "IDEA staged semantic search",
  description:
    "Search PSI-enriched modules/classes/methods via staged pipeline (bridge → Milvus). Returns module hits plus context-budgeted results including hierarchy/relations metadata.",
  inputSchema: searchArgsSchema,
  outputSchema: searchResultSchema,
};

async function handleSearchTool(args: SearchToolArguments) {
  const outcome = await searchPipeline.search(args);
  const moduleCandidates = (outcome.moduleResults ?? [])
    .slice(0, 5)
    .map(describeModuleCandidate);
  const stages = outcome.stages.map((stage) => ({
    name: stage.name,
    hitCount: stage.hits.length,
    kinds: Array.from(new Set(stage.hits.map((hit) => hit.kind))),
    levels: Array.from(
      new Set(stage.hits.map((hit) => hit.indexLevel ?? "unknown")),
    ),
  }));

  const resolvedPreferredLevels =
    args.preferredLevels ?? outcome.strategy.preferredLevels;
  const moduleHint = args.moduleHint ?? outcome.strategy.moduleHint ?? null;
  const contextBudget = {
    maxTokens: outcome.contextBudget.tokenLimit,
    usedTokens: outcome.contextBudget.usedTokens,
    omittedCount: outcome.contextBudget.omittedCount,
    truncated: outcome.contextBudget.truncated,
  };

  const deliveredHits = outcome.contextBudget.delivered.map(describeDeliveredHit);
  const totalCandidates =
    deliveredHits.length + outcome.contextBudget.omittedCount;

  const strategyDebug = {
    profile: outcome.strategy.profile,
    reason: outcome.strategy.reason,
    preferredLevels: outcome.strategy.preferredLevels,
    moduleLimit: outcome.strategy.moduleLimit,
    classLimit: outcome.strategy.classLimit,
    methodLimit: outcome.strategy.methodLimit,
    moduleFilter: outcome.strategy.moduleFilter ?? null,
    moduleHint: outcome.strategy.moduleHint ?? null,
    scenario: outcome.strategy.scenario ?? null,
    profileId: outcome.strategy.profileConfig.id,
  };

  const payload = {
    query: args.query,
    requestedLimit: args.limit ?? 5,
    moduleFilter: args.moduleFilter ?? null,
    moduleHint,
    preferredLevels: resolvedPreferredLevels,
    fallbackUsed: outcome.fallbackUsed,
    totalCandidates,
    deliveredCount: deliveredHits.length,
    omittedCount: outcome.contextBudget.omittedCount,
    stages,
    moduleCandidates,
    deliveredResults: deliveredHits,
    contextBudget,
    budget: {
      tokenLimit: contextBudget.maxTokens,
      usedTokens: contextBudget.usedTokens,
    },
    debug: {
      strategy: strategyDebug,
    },
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

server.registerTool("search_java_symbol", searchToolDefinition, handleSearchTool);

server.registerTool(
  "search_java_class",
  {
    ...searchToolDefinition,
    description:
      "[Deprecation notice] Alias of search_java_symbol. Prefer passing preferredLevels/moduleHint/maxContextTokens for staged control.",
  },
  handleSearchTool,
);

const transport = new StdioServerTransport();

(async () => {
  try {
    log("starting MCP server...");
    await server.connect(transport);
    log("MCP server ready (PSI staged search active).");
  } catch (error) {
    log("failed to start MCP server:", error);
    process.exitCode = 1;
  }
})();

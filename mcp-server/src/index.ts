import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const callersToolInputSchema = z.object({
  methodFqn: z
    .string({
      required_error: "methodFqn is required",
      invalid_type_error: "methodFqn must be a string",
    })
    .min(3, "methodFqn must be at least 3 characters"),
  excludeTest: z
    .boolean({ invalid_type_error: "excludeTest must be a boolean" })
    .optional(),
  maxResults: z
    .number({ invalid_type_error: "maxResults must be a number" })
    .int("maxResults must be an integer")
    .min(1, "maxResults must be >= 1")
    .max(500, "maxResults must be <= 500")
    .optional(),
  psiCachePath: z
    .string({ invalid_type_error: "psiCachePath must be a string" })
    .min(3, "psiCachePath must be at least 3 characters")
    .optional(),
});

type CallersToolInput = z.infer<typeof callersToolInputSchema>;

const calleesToolInputSchema = z.object({
  methodFqn: z
    .string({
      required_error: "methodFqn is required",
      invalid_type_error: "methodFqn must be a string",
    })
    .min(3, "methodFqn must be at least 3 characters"),
  maxResults: z
    .number({ invalid_type_error: "maxResults must be a number" })
    .int("maxResults must be an integer")
    .min(1, "maxResults must be >= 1")
    .max(500, "maxResults must be <= 500")
    .optional(),
  psiCachePath: z
    .string({ invalid_type_error: "psiCachePath must be a string" })
    .min(3, "psiCachePath must be at least 3 characters")
    .optional(),
});

type CalleesToolInput = z.infer<typeof calleesToolInputSchema>;

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
    isAbstract: z.boolean().optional(),
    isSealed: z.boolean().optional(),
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

type PsiCacheSymbol = {
  repoName: string;
  fqn: string;
  kind: string;
  module: string;
  modulePath: string;
  packageName: string;
  relativePath: string;
  filePath: string;
  summary: string;
  springInfo?: SpringInfo;
  annotations?: { name: string; fqn?: string; arguments?: string }[];
  hierarchy?: {
    superClass?: string;
    interfaces?: string[];
  };
  methods?: Array<{
    name: string;
    signature: string;
    visibility: string;
    returnType: string;
    returnTypeFqn?: string;
    parameters: Array<{ name: string; type: string; typeFqn?: string }>;
    annotations?: { name: string; fqn?: string; arguments?: string }[];
    javadoc?: string;
  }>;
  relations?: RelationInfo;
  quality?: { methodCount?: number; fieldCount?: number; annotationCount?: number };
};

type BehaviorClassification = {
  isSpringBean: boolean;
  beanType: string | null;
  beanName: string | null;
  roles: string[];
  isReactiveHandler: boolean;
  isTest: boolean;
};

type BehaviorExplanationResult = {
  targetSymbol: string;
  targetClass: string;
  targetMethod: string | null;
  classification: BehaviorClassification;
  callersPreview: CallersAnalysisResult | null;
  notes: string[];
};

type CallersAnalysisResult = {
  targetMethod: string;
  targetClass: string;
  callers: Array<{
    classFqn: string;
    module: string;
    packageName: string;
    filePath: string;
    isTest: boolean;
    source: "calls" | "references";
  }>;
  directCallers: number;
  referrers: number;
  moduleSummary: Array<{ module: string; count: number }>;
};

type OutgoingCallCategory =
  | "DB"
  | "HTTP"
  | "REDIS"
  | "MQ"
  | "EVENT"
  | "INTERNAL_SERVICE"
  | "FRAMEWORK"
  | "UNKNOWN";

type CalleesAnalysisResult = {
  targetMethod: string;
  targetClass: string;
  targetMethodName: string | null;
  callees: Array<{
    target: string;
    classFqn: string;
    methodName: string | null;
    module: string | null;
    packageName: string | null;
    filePath: string | null;
    callersCount?: number;
    calleesCount?: number;
    category: OutgoingCallCategory;
    source: "calls" | "references";
    implementations?: Array<{
      classFqn: string;
      module: string | null;
      packageName: string | null;
      filePath: string | null;
      callersCount?: number;
      calleesCount?: number;
      beanName?: string | null;
      beanType?: string | null;
    }>;
  }>;
  moduleSummary: Array<{ module: string; count: number }>;
  notes: string[];
};

function resolvePsiCachePath(overridePath?: string | null): string {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  const explicit = process.env.BRIDGE_PSI_CACHE ?? process.env.PSI_CACHE_PATH;
  if (explicit) {
    return explicit;
  }
  // Default to bridge-local cache under the monorepo.
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../idea-bridge/.idea-bridge/psi-cache.json",
  );
}

function analyzeCallersInPsiCache(input: CallersToolInput): CallersAnalysisResult {
  const methodFqn = input.methodFqn.trim();
  const hashIndex = methodFqn.indexOf("#");
  const targetClass = hashIndex > 0 ? methodFqn.slice(0, hashIndex) : methodFqn;
  const cachePath = resolvePsiCachePath(input.psiCachePath);
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read PSI cache at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(raw) as { symbols?: PsiCacheSymbol[] };
  } catch (error) {
    throw new Error(
      `Failed to parse PSI cache JSON at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const symbols: PsiCacheSymbol[] = Array.isArray(json?.symbols) ? (json.symbols as PsiCacheSymbol[]) : [];
  if (!symbols.length) {
    return {
      targetMethod: methodFqn,
      targetClass,
      callers: [],
      directCallers: 0,
      referrers: 0,
      moduleSummary: [],
    };
  }
  const excludeTest = input.excludeTest ?? true;
  const maxResults = input.maxResults ?? 200;
  const lowered = methodFqn.toLowerCase();
  const callers: CallersAnalysisResult["callers"] = [];
  let directCount = 0;
  let refCount = 0;

  // First pass: direct method calls (class#method).
  for (const sym of symbols) {
    const rel = sym.relations;
    if (!rel?.calls?.length) continue;
    const callsLower = rel.calls.map((c) => c.toLowerCase());
    if (!callsLower.some((c) => c === lowered)) continue;
    const isTest = /test/i.test(sym.fqn) || /\/test\//i.test(sym.filePath);
    if (excludeTest && isTest) continue;
    callers.push({
      classFqn: sym.fqn,
      module: sym.module,
      packageName: sym.packageName,
      filePath: sym.filePath,
      isTest,
      source: "calls",
    });
    directCount += 1;
    if (callers.length >= maxResults) break;
  }

  // Fallback: if no direct method calls are recorded in PSI, fall back to
  // "types that reference the target class" as a coarse impact list.
  if (!callers.length) {
    const targetClassLower = targetClass.toLowerCase();
    for (const sym of symbols) {
      const rel = sym.relations;
      const refs = rel?.references ?? [];
      if (!refs.length) continue;
      const refsLower = refs.map((ref) => ref.toLowerCase());
      if (!refsLower.includes(targetClassLower)) continue;
      const isTest = /test/i.test(sym.fqn) || /\/test\//i.test(sym.filePath);
      if (excludeTest && isTest) continue;
      callers.push({
        classFqn: sym.fqn,
        module: sym.module,
        packageName: sym.packageName,
        filePath: sym.filePath,
        isTest,
        source: "references",
      });
      refCount += 1;
      if (callers.length >= maxResults) break;
    }
  }
  callers.sort((a, b) => a.classFqn.localeCompare(b.classFqn));
  const moduleCounts = new Map<string, number>();
  for (const caller of callers) {
    const key = caller.module ?? "unknown";
    moduleCounts.set(key, (moduleCounts.get(key) ?? 0) + 1);
  }
  return {
    targetMethod: methodFqn,
    targetClass,
    callers,
    directCallers: directCount,
    referrers: refCount,
    moduleSummary: Array.from(moduleCounts.entries())
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module)),
  };
}

function getBasePackage(fqn: string): string | null {
  const parts = fqn.split(".");
  if (!parts.length) return null;
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return parts[0];
}

function extractQualifier(annotations?: { name: string; fqn?: string; arguments?: string }[]): string | null {
  if (!annotations?.length) return null;
  for (const ann of annotations) {
    const name = (ann.fqn ?? ann.name ?? "").toLowerCase();
    if (name.endsWith("qualifier") || name.endsWith("named")) {
      if (ann.arguments) {
        const match = ann.arguments.match(/["']([^"']+)["']/);
        if (match?.[1]) return match[1];
      }
      return ann.name ?? ann.fqn ?? null;
    }
  }
  return null;
}

function classifyOutgoingCallee(
  calleeFqn: string,
  calleePackage?: string | null,
  targetBasePackage?: string | null,
): OutgoingCallCategory {
  const lower = calleeFqn.toLowerCase();
  if (
    /jdbc|datasource|entitymanager|hibernate|jpa|transaction/.test(lower) ||
    /repository#/.test(lower)
  ) {
    return "DB";
  }
  if (/redis|lettuce|jedis|redistemplate/.test(lower)) {
    return "REDIS";
  }
  if (/kafka|rabbit|amqp|rocketmq|jms/.test(lower)) {
    return "MQ";
  }
  if (
    /webclient|resttemplate|restoperations|httpclient|apache\.http|okhttp|feign|httpexchange/.test(
      lower,
    )
  ) {
    return "HTTP";
  }
  if (/eventpublisher|eventmulticaster|applicationevent/.test(lower)) {
    return "EVENT";
  }
  const pkg = (calleePackage ?? calleeFqn.split("#")[0] ?? "").toLowerCase();
  if (
    pkg.startsWith("org.springframework") ||
    pkg.startsWith("jakarta.") ||
    pkg.startsWith("reactor.") ||
    pkg.startsWith("org.apache")
  ) {
    return "FRAMEWORK";
  }
  if (targetBasePackage && pkg.startsWith(targetBasePackage.toLowerCase())) {
    return "INTERNAL_SERVICE";
  }
  return "UNKNOWN";
}

function analyzeCalleesInPsiCache(input: CalleesToolInput): CalleesAnalysisResult {
  const methodFqn = input.methodFqn.trim();
  const hashIndex = methodFqn.indexOf("#");
  const targetClass = hashIndex > 0 ? methodFqn.slice(0, hashIndex) : methodFqn;
  const targetMethodName = hashIndex > 0 ? methodFqn.slice(hashIndex + 1) : null;
  const cachePath = resolvePsiCachePath(input.psiCachePath);
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read PSI cache at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(raw) as { symbols?: PsiCacheSymbol[] };
  } catch (error) {
    throw new Error(
      `Failed to parse PSI cache JSON at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const symbols: PsiCacheSymbol[] = Array.isArray(json?.symbols)
    ? (json.symbols as PsiCacheSymbol[])
    : [];
  const notes: string[] = [];
  if (!symbols.length) {
    return {
      targetMethod: methodFqn,
      targetClass,
      targetMethodName,
      callees: [],
      moduleSummary: [],
      notes: ["PSI cache is empty; no symbols available."],
    };
  }
  const targetSymbol =
    symbols.find((sym) => sym.fqn === targetClass) ??
    symbols.find((sym) => sym.fqn.endsWith(targetClass));
  if (!targetSymbol) {
    return {
      targetMethod: methodFqn,
      targetClass,
      targetMethodName,
      callees: [],
      moduleSummary: [],
      notes: ["Target symbol not found in PSI cache."],
    };
  }

  const mapByClass = new Map<string, PsiCacheSymbol>();
  const interfaceImpls = new Map<string, PsiCacheSymbol[]>();
  for (const sym of symbols) {
    mapByClass.set(sym.fqn, sym);
    const interfaces = sym.hierarchy?.interfaces ?? [];
    for (const iface of interfaces) {
      if (!iface) continue;
      const current = interfaceImpls.get(iface) ?? [];
      current.push(sym);
      interfaceImpls.set(iface, current);
    }
  }

  const rawCalls = Array.isArray(targetSymbol.relations?.calls)
    ? targetSymbol.relations?.calls ?? []
    : [];
  const maxResults = input.maxResults ?? 200;
  const targetBasePackage = getBasePackage(targetClass);
  const seen = new Set<string>();
  const callees: CalleesAnalysisResult["callees"] = [];

  const addCallee = (calleeFqn: string, source: "calls" | "references") => {
    const key = `${source}:${calleeFqn}`;
    if (seen.has(key)) return;
    seen.add(key);
    const [calleeClass, methodName] = calleeFqn.split("#");
    const calleeSymbol = calleeClass ? mapByClass.get(calleeClass) : undefined;
    const category = classifyOutgoingCallee(
      calleeFqn,
      calleeSymbol?.packageName ?? calleeClass,
      targetBasePackage,
    );
    const calleeCallersCount = calleeSymbol?.relations?.calledBy?.length ?? 0;
    const calleeCalleesCount = calleeSymbol?.relations?.calls?.length ?? 0;
    const implementations =
      calleeClass && calleeSymbol?.kind?.toUpperCase() === "INTERFACE"
        ? (interfaceImpls.get(calleeClass) ?? []).map((impl) => ({
            classFqn: impl.fqn,
            module: impl.module ?? null,
            packageName: impl.packageName ?? null,
            filePath: impl.filePath ?? null,
            callersCount: impl.relations?.calledBy?.length ?? 0,
            calleesCount: impl.relations?.calls?.length ?? 0,
            beanName: impl.springInfo?.beanName ?? extractQualifier(impl.annotations),
            beanType: impl.springInfo?.beanType ?? null,
          }))
        : [];

    callees.push({
      target: calleeFqn,
      classFqn: calleeClass ?? calleeFqn,
      methodName: methodName ?? null,
      module: calleeSymbol?.module ?? null,
      packageName: calleeSymbol?.packageName ?? null,
      filePath: calleeSymbol?.filePath ?? null,
      callersCount: calleeCallersCount || undefined,
      calleesCount: calleeCalleesCount || undefined,
      category,
      source,
      implementations: implementations.length ? implementations : undefined,
    });
  };

  for (const callee of rawCalls) {
    if (!callee) continue;
    addCallee(String(callee), "calls");
    if (callees.length >= maxResults) break;
  }

  if (!callees.length) {
    const references = targetSymbol.relations?.references ?? [];
    for (const ref of references) {
      if (!ref) continue;
      addCallee(String(ref), "references");
      if (callees.length >= maxResults) break;
    }
    if (references.length) {
      notes.push("No direct call edges recorded; returning referenced types instead.");
    }
  } else {
    notes.push("Calls are aggregated at class level; per-method edges are not available in PSI.");
  }

  for (const callee of callees) {
    if (callee.implementations?.length) {
      callee.implementations.sort((a, b) => {
        const countA = a.callersCount ?? 0;
        const countB = b.callersCount ?? 0;
        if (countA !== countB) return countB - countA;
        return a.classFqn.localeCompare(b.classFqn);
      });
    }
  }

  callees.sort((a, b) => {
    const scoreA = (a.callersCount ?? 0) + (a.calleesCount ?? 0);
    const scoreB = (b.callersCount ?? 0) + (b.calleesCount ?? 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.target.localeCompare(b.target);
  });

  const moduleCounts = new Map<string, number>();
  for (const callee of callees) {
    const key = callee.module ?? "unknown";
    moduleCounts.set(key, (moduleCounts.get(key) ?? 0) + 1);
  }
  const moduleSummary = Array.from(moduleCounts.entries())
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));

  return {
    targetMethod: methodFqn,
    targetClass,
    targetMethodName,
    callees,
    moduleSummary,
    notes,
  };
}

function classifyBehavior(
  symbol: PsiCacheSymbol,
  methodName: string | null,
): BehaviorClassification {
  const isTest =
    /test/i.test(symbol.fqn) ||
    /\/test\//i.test(symbol.filePath) ||
    /test/i.test(symbol.packageName);
  const springInfo = symbol.springInfo;
  const beanType = springInfo?.beanType ?? null;
  const beanName = springInfo?.beanName ?? null;

  const roles: string[] = [];
  if (springInfo?.isSpringBean) {
    roles.push("SPRING_BEAN");
    if (beanType?.toLowerCase().includes("controller")) roles.push("REST_CONTROLLER");
    if (beanType?.toLowerCase().includes("service")) roles.push("SERVICE");
    if (beanType?.toLowerCase().includes("repository")) roles.push("REPOSITORY");
    if (beanType?.toLowerCase().includes("config")) roles.push("CONFIG");
  }
  const annoFqns = (symbol.annotations ?? []).map((ann) => ann.fqn ?? ann.name);
  if (annoFqns.some((a) => a?.endsWith("RestController") || a?.endsWith("Controller"))) {
    roles.push("REST_CONTROLLER");
  }
  if (annoFqns.some((a) => a?.endsWith("Service"))) {
    roles.push("SERVICE");
  }
  if (annoFqns.some((a) => a?.endsWith("Repository"))) {
    roles.push("REPOSITORY");
  }
  if (annoFqns.some((a) => a?.endsWith("Configuration"))) {
    roles.push("CONFIG");
  }

  let isReactiveHandler = false;
  const pkg = symbol.packageName ?? "";
  const fqn = symbol.fqn;
  if (symbol.methods && methodName) {
    const candidate = symbol.methods.find((m) => m.name === methodName);
    if (candidate) {
      const ret = candidate.returnTypeFqn ?? candidate.returnType;
      if (ret.includes("Mono<") || ret.includes("Flux<")) {
        isReactiveHandler = true;
      }
      const paramTypes = candidate.parameters.map(
        (p) => p.typeFqn ?? p.type ?? "",
      );
      if (
        paramTypes.some((t) =>
          t.includes("ServerRequest") ||
          t.includes("ServerResponse") ||
          t.includes("org.springframework.web.reactive"),
        )
      ) {
        isReactiveHandler = true;
      }

      const methodAnnoFqns = (candidate.annotations ?? []).map(
        (ann) => ann.fqn ?? ann.name,
      );
      if (
        methodAnnoFqns.some((a) =>
          a?.includes("RequestMapping") ||
          a?.includes("GetMapping") ||
          a?.includes("PostMapping") ||
          a?.includes("PutMapping") ||
          a?.includes("DeleteMapping") ||
          a?.includes("PatchMapping"),
        )
      ) {
        roles.push("HTTP_HANDLER");
      }
      if (methodAnnoFqns.some((a) => a?.endsWith("EventListener"))) {
        roles.push("EVENT_LISTENER");
      }
    }
  }

  // WebFlux / reactive infrastructure roles.
  if (pkg.includes("org.springframework.web.reactive")) {
    if (
      fqn.includes("DispatcherHandler") ||
      fqn.includes("HandlerAdapter") ||
      fqn.includes("HandlerMapping")
    ) {
      roles.push("REACTIVE_INFRA");
    }
    if (isReactiveHandler) {
      roles.push("REACTIVE_HANDLER");
    }
  }

  // Event infrastructure roles.
  if (pkg.includes("org.springframework.context.event")) {
    if (fqn.includes("ApplicationEventMulticaster")) {
      roles.push("EVENT_DISPATCHER");
    }
    if (fqn.includes("ApplicationEventPublisher")) {
      roles.push("EVENT_PUBLISHER");
    }
  }

  return {
    isSpringBean: springInfo?.isSpringBean ?? false,
    beanType,
    beanName,
    roles: Array.from(new Set(roles)),
    isReactiveHandler,
    isTest,
  };
}

function explainBehaviorInPsiCache(
  symbolFqn: string,
  psiCachePath?: string | null,
): BehaviorExplanationResult {
  const trimmed = symbolFqn.trim();
  const hashIndex = trimmed.indexOf("#");
  const targetClass = hashIndex > 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const targetMethod = hashIndex > 0 ? trimmed.slice(hashIndex + 1) : null;

  const cachePath = resolvePsiCachePath(psiCachePath);
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read PSI cache at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(raw) as { symbols?: PsiCacheSymbol[] };
  } catch (error) {
    throw new Error(
      `Failed to parse PSI cache JSON at ${cachePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const symbols: PsiCacheSymbol[] = Array.isArray(json?.symbols)
    ? (json.symbols as PsiCacheSymbol[])
    : [];
  if (!symbols.length) {
    return {
      targetSymbol: trimmed,
      targetClass,
      targetMethod,
      classification: {
        isSpringBean: false,
        beanType: null,
        beanName: null,
        roles: [],
        isReactiveHandler: false,
        isTest: false,
      },
      callersPreview: null,
      notes: ["PSI cache is empty; no symbols available."],
    };
  }
  const symbol =
    symbols.find((sym) => sym.fqn === targetClass) ??
    symbols.find((sym) => sym.fqn.endsWith(targetClass));
  if (!symbol) {
    return {
      targetSymbol: trimmed,
      targetClass,
      targetMethod,
      classification: {
        isSpringBean: false,
        beanType: null,
        beanName: null,
        roles: [],
        isReactiveHandler: false,
        isTest: false,
      },
      callersPreview: null,
      notes: ["Target symbol not found in PSI cache."],
    };
  }

  const classification = classifyBehavior(symbol, targetMethod);
  let callersPreview: CallersAnalysisResult | null = null;
  if (targetMethod) {
    try {
      callersPreview = analyzeCallersInPsiCache({
        methodFqn: trimmed,
        excludeTest: true,
        maxResults: 50,
        psiCachePath: psiCachePath ?? undefined,
      });
    } catch {
      callersPreview = null;
    }
  }

  const notes: string[] = [];
  notes.push(
    `Symbol ${targetMethod ? "method" : "class"}: ${trimmed} (class: ${targetClass})`,
  );
  if (classification.isSpringBean) {
    notes.push(
      `Spring bean: ${classification.beanType ?? "unknown type"}${
        classification.beanName ? `, name=${classification.beanName}` : ""
      }`,
    );
  }
  if (classification.roles.length) {
    notes.push(`Inferred roles: ${classification.roles.join(", ")}`);
  }
  if (classification.isReactiveHandler) {
    notes.push("Reactive handler: returns Mono/Flux or uses WebFlux types.");
  }
  if (classification.isTest) {
    notes.push("Located under test package or path; likely test code.");
  }
  if (callersPreview && callersPreview.callers.length) {
    notes.push(
      `Direct callers in PSI: ${callersPreview.callers.length} class(es) (tests excluded).`,
    );
  } else if (targetMethod) {
    notes.push("No direct method callers recorded in PSI cache (tests excluded).");
  }

  return {
    targetSymbol: trimmed,
    targetClass,
    targetMethod,
    classification,
    callersPreview,
    notes,
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

server.registerTool(
  "analyze_callers_of_method",
  {
    title: "Analyze callers of a Java method using PSI call graph",
    description:
      "Given a method FQN like 'com.company.ws.WsHttpClient#send', scan the PSI cache and return classes that call this method.",
    inputSchema: callersToolInputSchema,
    outputSchema: z.object({
      targetMethod: z.string(),
      targetClass: z.string(),
      callers: z.array(
        z.object({
          classFqn: z.string(),
          module: z.string(),
          packageName: z.string(),
          filePath: z.string(),
          isTest: z.boolean(),
          source: z.enum(["calls", "references"]),
        }),
      ),
      directCallers: z.number(),
      referrers: z.number(),
      moduleSummary: z.array(
        z.object({
          module: z.string(),
          count: z.number(),
        }),
      ),
    }),
  },
  async (args) => {
    const parsed = callersToolInputSchema.parse(args ?? {});
    let analysis: CallersAnalysisResult;
    try {
      analysis = analyzeCallersInPsiCache(parsed);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to analyze callers: ${String(error)}`;
      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
        structuredContent: {
          targetMethod: parsed.methodFqn,
          targetClass: parsed.methodFqn.split("#")[0] ?? parsed.methodFqn,
          callers: [],
          directCallers: 0,
          referrers: 0,
          moduleSummary: [],
        },
      };
    }
  const summaryLines = [
    `Target method: ${analysis.targetMethod} (class: ${analysis.targetClass})`,
    `Callers (${analysis.callers.length}, direct=${analysis.directCallers}, referrers=${analysis.referrers}):`,
    ...analysis.callers.slice(0, 10).map((caller) =>
      `- ${caller.classFqn} [module=${caller.module}] ${caller.isTest ? "(TEST)" : ""} source=${caller.source}`,
    ),
    analysis.callers.length > 10
      ? `… and ${analysis.callers.length - 10} more caller classes.`
      : "",
    analysis.moduleSummary.length
      ? `Module summary: ${analysis.moduleSummary
          .map((m) => `${m.module}:${m.count}`)
          .join(", ")}`
      : "",
  ].filter((line) => line.length > 0);
    return {
      content: [
        {
          type: "text",
          text: summaryLines.join("\n"),
        },
      ],
      structuredContent: analysis,
    };
  },
);

const calleeCategorySchema = z.enum([
  "DB",
  "HTTP",
  "REDIS",
  "MQ",
  "EVENT",
  "INTERNAL_SERVICE",
  "FRAMEWORK",
  "UNKNOWN",
]);

server.registerTool(
  "analyze_callees_of_method",
  {
    title: "Analyze outgoing calls of a Java method using PSI call graph",
    description:
      "Given a method FQN like 'com.company.ws.WsHttpClient#send', list the methods/types it calls (class-level aggregation) with coarse categories like DB/HTTP/Redis/MQ/internal service.",
    inputSchema: calleesToolInputSchema,
    outputSchema: z.object({
      targetMethod: z.string(),
      targetClass: z.string(),
      targetMethodName: z.string().nullable(),
      callees: z.array(
        z.object({
          target: z.string(),
          classFqn: z.string(),
          methodName: z.string().nullable(),
          module: z.string().nullable(),
          packageName: z.string().nullable(),
          filePath: z.string().nullable(),
          callersCount: z.number().optional(),
          calleesCount: z.number().optional(),
          category: calleeCategorySchema,
          source: z.enum(["calls", "references"]),
          implementations: z
            .array(
              z.object({
                classFqn: z.string(),
                module: z.string().nullable(),
                packageName: z.string().nullable(),
                filePath: z.string().nullable(),
                callersCount: z.number().optional(),
                calleesCount: z.number().optional(),
                beanName: z.string().nullable().optional(),
                beanType: z.string().nullable().optional(),
              }),
            )
            .optional(),
        }),
      ),
      moduleSummary: z.array(
        z.object({
          module: z.string(),
          count: z.number(),
        }),
      ),
      notes: z.array(z.string()),
    }),
  },
  async (args) => {
    const parsed = calleesToolInputSchema.parse(args ?? {});
    let analysis: CalleesAnalysisResult;
    try {
      analysis = analyzeCalleesInPsiCache(parsed);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Failed to analyze callees: ${String(error)}`;
      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
        structuredContent: {
          targetMethod: parsed.methodFqn,
          targetClass: parsed.methodFqn.split("#")[0] ?? parsed.methodFqn,
          targetMethodName: parsed.methodFqn.includes("#")
            ? parsed.methodFqn.split("#")[1] ?? null
            : null,
          callees: [],
          moduleSummary: [],
          notes: [message],
        },
      };
    }
    const summaryLines = [
      `Target method: ${analysis.targetMethod}`,
      `Outgoing callees (${analysis.callees.length}):`,
      ...analysis.callees.slice(0, 10).map((callee) => {
        const implNote = callee.implementations?.length
          ? ` (impls=${callee.implementations.length})`
          : "";
        return `- ${callee.target} [${callee.category}]${callee.source === "references" ? " (reference)" : ""}${implNote}`;
      }),
      analysis.callees.length > 10
        ? `… and ${analysis.callees.length - 10} more callees.`
        : "",
      analysis.moduleSummary.length
        ? `Modules touched: ${analysis.moduleSummary
            .slice(0, 5)
            .map((item) => `${item.module}(${item.count})`)
            .join(", ")}`
        : "",
      ...analysis.notes,
    ].filter((line) => line.length > 0);
    return {
      content: [
        {
          type: "text",
          text: summaryLines.join("\n"),
        },
      ],
      structuredContent: analysis,
    };
  },
);

const explainBehaviorInputSchema = z.object({
  symbolFqn: z
    .string({
      required_error: "symbolFqn is required",
      invalid_type_error: "symbolFqn must be a string",
    })
    .min(3, "symbolFqn must be at least 3 characters")
    .describe(
      "Fully qualified class or method name, e.g. com.foo.Bar or com.foo.Bar#baz",
    ),
  psiCachePath: z
    .string({ invalid_type_error: "psiCachePath must be a string" })
    .min(3, "psiCachePath must be at least 3 characters")
    .optional(),
});

server.registerTool(
  "explain_symbol_behavior",
  {
    title: "Explain Spring/Java symbol behavior using PSI metadata",
    description:
      "Given a class or method FQN like 'org.springframework.jdbc.core.JdbcTemplate#query', summarize its Spring roles, reactive usage, and direct callers based on PSI cache.",
    inputSchema: explainBehaviorInputSchema,
    outputSchema: z.object({
      targetSymbol: z.string(),
      targetClass: z.string(),
      targetMethod: z.string().nullable(),
      classification: z.object({
        isSpringBean: z.boolean(),
        beanType: z.string().nullable(),
        beanName: z.string().nullable(),
        roles: z.array(z.string()),
        isReactiveHandler: z.boolean(),
        isTest: z.boolean(),
      }),
      callersPreview: z
        .object({
          targetMethod: z.string(),
          targetClass: z.string(),
          callers: z.array(
            z.object({
              classFqn: z.string(),
              module: z.string(),
              packageName: z.string(),
              filePath: z.string(),
              isTest: z.boolean(),
            }),
          ),
        })
        .nullable(),
      notes: z.array(z.string()),
    }),
  },
  async (args) => {
    const parsed = explainBehaviorInputSchema.parse(args ?? {});
    let result: BehaviorExplanationResult;
    try {
      result = explainBehaviorInPsiCache(parsed.symbolFqn, parsed.psiCachePath);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Failed to explain behavior: ${String(error)}`;
      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
        structuredContent: {
          targetSymbol: parsed.symbolFqn,
          targetClass: parsed.symbolFqn.split("#")[0] ?? parsed.symbolFqn,
          targetMethod: parsed.symbolFqn.includes("#")
            ? parsed.symbolFqn.split("#")[1] ?? null
            : null,
          classification: {
            isSpringBean: false,
            beanType: null,
            beanName: null,
            roles: [],
            isReactiveHandler: false,
            isTest: false,
          },
          callersPreview: null,
          notes: [message],
        },
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.notes.join("\n"),
        },
      ],
      structuredContent: result,
    };
  },
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

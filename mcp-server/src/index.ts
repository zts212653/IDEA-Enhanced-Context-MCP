import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createIdeaBridgeClient } from "./bridgeClient.js";
import { createMilvusSearchClient } from "./milvusClient.js";
import {
  createSearchPipeline,
  type MilvusSearchHandle,
} from "./searchPipeline.js";
import type { SymbolRecord } from "./types.js";

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
});

type SearchToolArguments = z.infer<typeof searchArgsSchema>;

const ideaBridgeClient = createIdeaBridgeClient();
const milvusClientHandle = createMilvusSearchClient();

const milvusSearchHandle: MilvusSearchHandle | undefined = milvusClientHandle;

const searchPipeline = createSearchPipeline({
  bridgeClient: ideaBridgeClient,
  milvusClient: milvusSearchHandle,
  fallbackSymbols: mockSymbols,
});

const server = new McpServer(
  {
    name: "idea-enhanced-context",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
    instructions:
      "Mock search endpoint for IDEA semantic index. Replace searchSymbols() with Bridge+Milvus integration.",
  },
);

const searchResultSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(20),
  moduleFilter: z.string().nullable(),
  total: z.number().int().min(0),
  results: z.array(
    z.object({
      fqn: z.string(),
      kind: z.enum(["CLASS", "INTERFACE", "METHOD"]),
      module: z.string(),
      summary: z.string(),
      score: z.number().min(0).max(1),
      scoreHints: z
        .object({
          references: z.number().int().nonnegative().optional(),
          lastModifiedDays: z.number().int().nonnegative().optional(),
        })
        .partial()
        .optional(),
    }),
  ),
});

server.registerTool(
  "search_java_class",
  {
    title: "IDEA semantic search (mock)",
    description:
      "Search Java classes or methods using IDEA semantic index. Currently returns static data pending Bridge hookup.",
    inputSchema: searchArgsSchema,
    outputSchema: searchResultSchema,
  },
  async (args) => {
    const results = await searchPipeline.search(args);
    const payload = {
      query: args.query,
      limit: args.limit ?? 5,
      moduleFilter: args.moduleFilter ?? null,
      total: results.length,
      results,
    };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2),
        },
      ],
      structuredContent: payload,
    };
  },
);

const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.log(
      "[idea-enhanced-context] MCP server ready (mock search only for now).",
    );
  })
  .catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exitCode = 1;
  });

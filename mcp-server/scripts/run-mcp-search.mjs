#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEnv = {
  ...process.env,
  IDEA_BRIDGE_URL:
    process.env.IDEA_BRIDGE_URL ??
    process.env.IDEA_BRIDGE_BASE_URL ??
    "http://127.0.0.1:63000",
  MILVUS_ADDRESS: process.env.MILVUS_ADDRESS ?? "127.0.0.1:19530",
  DISABLE_SCHEMA_CHECK: process.env.DISABLE_SCHEMA_CHECK ?? "0",
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  env: serverEnv,
  stderr: "inherit",
});

const client = new Client({
  name: "idea-enhanced-context-cli",
  version: "0.1.0",
});

async function main() {
  await client.connect(transport);

  const tools = await client.listTools({});
  client.cacheToolOutputSchemas(tools.tools ?? []);

  const [queryArg, moduleHintArg] = process.argv.slice(2);
  const parsedPreferred =
    process.env.PREFERRED_LEVELS?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  const preferredLevels = parsedPreferred.length ? parsedPreferred : undefined;

  const parsedMax = process.env.MAX_CONTEXT_TOKENS
    ? Number(process.env.MAX_CONTEXT_TOKENS)
    : undefined;
  const maxContextTokens =
    parsedMax && Number.isFinite(parsedMax) ? parsedMax : undefined;

  const toolResult = await client.callTool({
    name: "search_java_symbol",
    arguments: {
      query: queryArg ?? process.env.MCP_QUERY ?? "service",
      moduleHint: moduleHintArg ?? process.env.MODULE_HINT ?? undefined,
      preferredLevels,
      maxContextTokens,
    },
  });

  if (toolResult.isError) {
    console.error("Tool returned error:", toolResult.error);
    process.exit(1);
  }

  console.log(
    JSON.stringify(toolResult.structuredContent ?? toolResult.content, null, 2),
  );
}

main()
  .catch((error) => {
    console.error("Failed to call MCP tool:", error);
    process.exit(1);
  })
  .finally(async () => {
    await client.close();
    if (typeof transport.close === "function") {
      await transport.close();
    }
  });

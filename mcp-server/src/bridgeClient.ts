import { z } from "zod";

import type { SymbolRecord } from "./types.js";

const bridgeResponseSchema = z.object({
  results: z.array(
    z
      .object({
        fqn: z.string(),
        kind: z.enum(["CLASS", "INTERFACE", "METHOD"]),
        module: z.string(),
        summary: z.string(),
        scoreHints: z
          .object({
            references: z.number().int().nonnegative().optional(),
            lastModifiedDays: z.number().int().nonnegative().optional(),
          })
          .partial()
          .optional(),
      })
      .passthrough(),
  ),
});

export interface IdeaBridgeClient {
  searchSymbols(params: {
    query: string;
    limit: number;
    moduleFilter?: string;
  }): Promise<SymbolRecord[]>;
}

export function createIdeaBridgeClient(): IdeaBridgeClient | undefined {
  const baseUrl =
    process.env.IDEA_BRIDGE_BASE_URL ??
    process.env.IDEA_BRIDGE_URL ??
    process.env.IDEA_BRIDGE_HTTP ??
    "http://127.0.0.1:63000";

  if (!baseUrl) {
    return undefined;
  }

  const controller = new AbortController();

  return {
    async searchSymbols({ query, limit, moduleFilter }) {
      const url = new URL("/api/symbols/search", baseUrl);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", limit.toString());
      if (moduleFilter) {
        url.searchParams.set("module", moduleFilter);
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(
          `Bridge search failed (${response.status}) ${await response.text()}`,
        );
      }

      const json = await response.json();
      const parsed = bridgeResponseSchema.parse(json);
      return parsed.results;
    },
  };
}

export function disposeBridgeClient(client: IdeaBridgeClient | undefined) {
  if (!client) {
    return;
  }
  // placeholder for future streaming/WS teardown
}

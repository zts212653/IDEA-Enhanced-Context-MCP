import { describe, expect, it, vi } from "vitest";

import type { IdeaBridgeClient } from "./bridgeClient.js";
import { createSearchPipeline } from "./searchPipeline.js";
import type { SymbolRecord } from "./types.js";

const fallbackSymbols: SymbolRecord[] = [
  {
    fqn: "com.example.DefaultService",
    kind: "CLASS",
    module: "core",
    summary: "Default service implementation used when upstream fails.",
  },
];

const baseArgs = { query: "service" };

describe("searchPipeline", () => {
  it("prefers IDEA bridge results when available", async () => {
    const bridgeHits: SymbolRecord[] = [
      {
        fqn: "com.example.UserService",
        kind: "INTERFACE",
        module: "auth",
        summary: "Handles user lifecycle.",
      },
    ];
    const bridgeClient: IdeaBridgeClient = {
      searchSymbols: vi.fn().mockResolvedValue(bridgeHits),
    };

    const pipeline = createSearchPipeline({
      bridgeClient,
      milvusClient: undefined,
      fallbackSymbols,
    });

    const results = await pipeline.search(baseArgs);
    expect(results[0]?.fqn).toBe("com.example.UserService");
    expect(bridgeClient.searchSymbols).toHaveBeenCalledTimes(1);
  });

  it("falls back to Milvus when bridge is unavailable", async () => {
    const milvusHits: SymbolRecord[] = [
      {
        fqn: "com.example.billing.InvoiceService",
        kind: "CLASS",
        module: "billing",
        summary: "Creates invoices",
      },
    ];
    const pipeline = createSearchPipeline({
      bridgeClient: undefined,
      milvusClient: {
        search: vi.fn().mockResolvedValue(milvusHits),
      },
      fallbackSymbols,
    });

    const results = await pipeline.search(baseArgs);
    expect(results[0]?.fqn).toBe("com.example.billing.InvoiceService");
  });

  it("uses fallback data when no upstream sources return results", async () => {
    const pipeline = createSearchPipeline({
      bridgeClient: {
        searchSymbols: vi.fn().mockRejectedValue(new Error("bridge down")),
      },
      milvusClient: {
        search: vi.fn().mockResolvedValue(undefined),
      },
      fallbackSymbols,
    });

    const results = await pipeline.search(baseArgs);
    expect(results[0]?.fqn).toBe("com.example.DefaultService");
  });
});

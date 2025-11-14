import type { IdeaBridgeClient } from "./bridgeClient.js";
import type { SearchHit, SymbolRecord } from "./types.js";

export type SearchArguments = {
  query: string;
  limit?: number;
  moduleFilter?: string;
  preferredLevels?: string[];
};

export interface MilvusSearchHandle {
  search(params: SearchArguments): Promise<SymbolRecord[] | undefined>;
}

export function rankSymbols(
  symbols: SymbolRecord[],
  args: SearchArguments,
): SearchHit[] {
  const normalizedQuery = args.query.trim().toLowerCase();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);

  return symbols
    .filter((symbol) => {
      const haystack = `${symbol.fqn} ${symbol.summary}`.toLowerCase();
      const matchesQuery = haystack.includes(normalizedQuery);
      const matchesModule = args.moduleFilter
        ? symbol.module === args.moduleFilter
        : true;
      return matchesQuery && matchesModule;
    })
    .map((symbol) => {
      const baseScore = symbol.summary.toLowerCase().includes(normalizedQuery)
        ? 0.7
        : 0.5;
      const refBoost = (symbol.scoreHints?.references ?? 0) / 100;
      const recencyBoost =
        (symbol.scoreHints?.lastModifiedDays ?? 90) < 14 ? 0.15 : 0;
      return {
        symbol,
        score: Math.min(baseScore + refBoost + recencyBoost, 1),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ symbol, score }) => ({ ...symbol, score }));
}

export function createSearchPipeline({
  bridgeClient,
  milvusClient,
  fallbackSymbols,
}: {
  bridgeClient?: IdeaBridgeClient;
  milvusClient?: MilvusSearchHandle;
  fallbackSymbols: SymbolRecord[];
}) {
  async function tryBridge(args: SearchArguments) {
    if (!bridgeClient) {
      return undefined;
    }
    try {
      const response = await bridgeClient.searchSymbols({
        query: args.query,
        limit: args.limit ?? 5,
        moduleFilter: args.moduleFilter,
      });
      return response.length > 0 ? rankSymbols(response, args) : undefined;
    } catch (error) {
      console.warn("[idea-enhanced-context] Bridge search failed:", error);
      return undefined;
    }
  }

  async function tryMilvus(args: SearchArguments) {
    if (!milvusClient) {
      return undefined;
    }
    try {
      const records = await milvusClient.search(args);
      return records && records.length > 0
        ? rankSymbols(records, args)
        : undefined;
    } catch (error) {
      console.warn("[idea-enhanced-context] Milvus search failed:", error);
      return undefined;
    }
  }

  async function search(args: SearchArguments): Promise<SearchHit[]> {
    const bridgeResults = await tryBridge(args);
    if (bridgeResults && bridgeResults.length > 0) {
      return bridgeResults;
    }

    const moduleFirst = await tryMilvus({
      ...args,
      preferredLevels: ["module"],
      limit: 5,
    });
    if (moduleFirst && moduleFirst.length > 0) {
      return moduleFirst;
    }

    const classResults = await tryMilvus({
      ...args,
      preferredLevels: ["class", "method"],
    });
    if (classResults && classResults.length > 0) {
      return classResults;
    }

    return rankSymbols(fallbackSymbols, args);
  }

  return {
    search,
  };
}

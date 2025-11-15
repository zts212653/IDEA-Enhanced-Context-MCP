import { createRequire } from "node:module";

import type { ContextBudgetReport, SearchOutcome, SearchStage, SearchStrategy } from "./searchPipeline.js";
import type { SearchHit } from "./types.js";

const require = createRequire(import.meta.url);
const fixtureData = require("./fixtures/petclinic-fixtures.json");

export type FixtureEntry = {
  finalResults: SearchHit[];
  contextBudget?: Partial<ContextBudgetReport>;
  stages?: SearchStage[];
  fallbackUsed?: boolean;
};

type FixtureMap = Record<string, FixtureEntry>;

export class FixtureRegistry {
  constructor(private readonly entries: FixtureMap) {}

  has(id: string | undefined | null): boolean {
    if (!id) return false;
    return Boolean(this.entries[id]);
  }

  buildOutcome(
    id: string,
    strategy: SearchStrategy,
    tokenLimit: number,
  ): SearchOutcome | undefined {
    const entry = this.entries[id];
    if (!entry) return undefined;
    const finalResults = entry.finalResults ?? [];
    const budget = normalizeBudget(entry.contextBudget, finalResults, tokenLimit);
    return {
      finalResults,
      moduleResults: undefined,
      methodResults: undefined,
      fallbackUsed: entry.fallbackUsed ?? false,
      stages: entry.stages ?? [],
      strategy,
      contextBudget: budget,
    };
  }
}

function normalizeBudget(
  partial: FixtureEntry["contextBudget"] | undefined,
  delivered: SearchHit[],
  tokenLimit: number,
): ContextBudgetReport {
  const usedTokens = partial?.usedTokens ?? Math.min(tokenLimit, delivered.length * 40);
  return {
    delivered: partial?.delivered ?? delivered,
    usedTokens,
    tokenLimit: partial?.tokenLimit ?? tokenLimit,
    omittedCount: partial?.omittedCount ?? 0,
    truncated: partial?.truncated ?? false,
  };
}

export function createFixtureRegistry(enabled: boolean): FixtureRegistry | undefined {
  if (!enabled) {
    return undefined;
  }
  return new FixtureRegistry(fixtureData as FixtureMap);
}

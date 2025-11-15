import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ContextBudgetReport, SearchOutcome, SearchStage, SearchStrategy } from "./searchPipeline.js";
import type { SearchHit } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CANDIDATES = [
  path.resolve(__dirname, "../fixtures/petclinic-fixtures.json"),
  path.resolve(process.cwd(), "mcp-server/fixtures/petclinic-fixtures.json"),
  path.resolve(process.cwd(), "../mcp-server/fixtures/petclinic-fixtures.json"),
];

function loadFixtureData(): FixtureMap | undefined {
  for (const candidate of FIXTURE_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, "utf8");
        return JSON.parse(raw) as FixtureMap;
      }
    } catch {
      // fall through to next candidate
    }
  }
  return undefined;
}

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
  const data = loadFixtureData();
  if (!data) {
    console.warn(
      "[idea-enhanced-context] fixture mode requested but petclinic fixtures were not found",
    );
    return undefined;
  }
  return new FixtureRegistry(data);
}

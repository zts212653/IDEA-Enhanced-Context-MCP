import type { BridgeConfig } from "./config.js";
import { buildSymbolRecords } from "./indexer.js";
import { loadPsiCache } from "./psiCache.js";
import type { SymbolRecord } from "./types.js";

export type DataSourceKind = "psi-cache" | "regex";

export interface PsiLoadResult {
  records: SymbolRecord[];
  source: DataSourceKind;
  cacheInfo?: {
    schemaVersion?: number;
    symbolCount: number;
  };
}

export async function loadInitialSymbols(
  config: BridgeConfig,
  log?: { info: (data: Record<string, unknown>, msg: string) => void },
): Promise<PsiLoadResult> {
  const cached = await loadPsiCache(config.psiCachePath);
  if (cached?.symbols?.length) {
    log?.info(
      {
        cachePath: config.psiCachePath,
        schemaVersion: cached.schemaVersion,
        symbolCount: cached.symbols.length,
      },
      "loaded PSI cache from previous export",
    );
    return {
      records: cached.symbols,
      source: "psi-cache",
      cacheInfo: {
        schemaVersion: cached.schemaVersion,
        symbolCount: cached.symbols.length,
      },
    };
  }

  log?.info(
    { projectRoot: config.projectRoot },
    "building symbol index via regex fallback",
  );
  const records = await buildSymbolRecords({ projectRoot: config.projectRoot });
  return {
    records,
    source: "regex",
  };
}

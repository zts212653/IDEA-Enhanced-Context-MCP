import path from "node:path";

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
    const normalized = normalizeCachedSymbols(cached.symbols, config.projectRoot);
    log?.info(
      {
        cachePath: config.psiCachePath,
        schemaVersion: cached.schemaVersion,
        symbolCount: normalized.length,
      },
      "loaded PSI cache from previous export",
    );
    return {
      records: normalized,
      source: "psi-cache",
      cacheInfo: {
        schemaVersion: cached.schemaVersion,
        symbolCount: normalized.length,
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

function normalizeCachedSymbols(records: SymbolRecord[], projectRoot: string) {
  return records.map((record) => {
    if (!record.filePath) {
      return record;
    }
    const relativePath = path.relative(projectRoot, record.filePath);
    const isInsideProject = !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
    if (!isInsideProject) {
      return record;
    }
    const segments = relativePath.split(path.sep).filter(Boolean);
    const moduleName = segments[0] ?? record.module;
    const updated: SymbolRecord = {
      ...record,
      module: moduleName || record.module,
      modulePath: path.join(projectRoot, moduleName ?? record.module ?? ""),
      relativePath:
        record.relativePath && record.relativePath !== record.filePath
          ? record.relativePath
          : relativePath,
    };
    return updated;
  });
}

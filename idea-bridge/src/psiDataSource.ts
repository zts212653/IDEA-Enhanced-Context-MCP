import fs from "node:fs/promises";
import path from "node:path";

import type { BridgeConfig } from "./config.js";
import { buildSymbolRecords } from "./indexer.js";
import { loadPsiCache } from "./psiCache.js";
import type { SymbolRecord } from "./types.js";

export type DataSourceKind = "psi-cache" | "regex";

export interface PsiLoadResult {
  records: SymbolRecord[];
  source: DataSourceKind;
  cachePath?: string;
  cacheInfo?: {
    schemaVersion?: number;
    symbolCount: number;
  };
}

export async function loadInitialSymbols(
  config: BridgeConfig,
  log?: { info: (data: Record<string, unknown>, msg: string) => void },
): Promise<PsiLoadResult> {
  const candidatePaths = await resolveCandidateCaches(config);
  for (const cachePath of candidatePaths) {
    const cached = await loadPsiCache(cachePath);
    if (cached?.symbols?.length) {
      const normalized = normalizeCachedSymbols(cached.symbols, config.projectRoot);
      log?.info(
        {
          cachePath,
          schemaVersion: cached.schemaVersion,
          symbolCount: normalized.length,
        },
        "loaded PSI cache from previous export",
      );
      return {
        records: normalized,
        source: "psi-cache",
        cachePath,
        cacheInfo: {
          schemaVersion: cached.schemaVersion,
          symbolCount: normalized.length,
        },
      };
    }
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

function normalizeCachedSymbols(records: SymbolRecord[], configuredRoot: string) {
  return records.map((record) => {
    if (!record.filePath) {
      return record;
    }
    const effectiveRoot = deriveProjectRoot(record.filePath, configuredRoot, record.repoName);
    const relativePath = path.relative(effectiveRoot, record.filePath);
    const isInsideProject =
      relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
    if (!isInsideProject) {
      return {
        ...record,
        relativePath: record.relativePath ?? record.filePath,
      };
    }
    const segments = relativePath.split(path.sep).filter(Boolean);
    const moduleName = segments[0] ?? record.module ?? record.repoName;
    const updated: SymbolRecord = {
      ...record,
      module: moduleName,
      modulePath: moduleName,
      relativePath,
      filePath: record.filePath,
    };
    return updated;
  });
}

async function resolveCandidateCaches(config: BridgeConfig): Promise<string[]> {
  const paths: string[] = [config.psiCachePath];
  const dirs = new Set<string>();
  dirs.add(path.dirname(config.psiCachePath));
  if (config.psiCacheDir) {
    dirs.add(config.psiCacheDir);
  }
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const jsonFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
      const stats: Array<{ name: string; mtime: number }> = [];
      for (const name of jsonFiles) {
        const fullPath = path.join(dir, name);
        try {
          const stat = await fs.stat(fullPath);
          stats.push({ name: fullPath, mtime: stat.mtimeMs });
        } catch {
          // ignore
        }
      }
      stats.sort((a, b) => b.mtime - a.mtime);
      for (const item of stats) {
        if (!paths.includes(item.name)) {
          paths.push(item.name);
        }
      }
    } catch {
      // ignore dir errors
    }
  }
  // Ensure unique order, prefer explicit path first.
  return Array.from(new Set(paths));
}

function deriveProjectRoot(filePath: string, configuredRoot: string, repoName?: string) {
  if (configuredRoot && isSubPath(filePath, configuredRoot)) {
    return configuredRoot;
  }
  const normalized = path.normalize(filePath);
  const parts = normalized.split(path.sep).filter((part, idx) => part || idx === 0);
  const repoIndex = repoName ? parts.lastIndexOf(repoName) : -1;
  if (repoIndex > 0) {
    const prefix = parts.slice(0, repoIndex + 1);
    const candidate = prefix.join(path.sep) || path.sep;
    return candidate;
  }
  return configuredRoot || path.dirname(filePath);
}

function isSubPath(target: string, root: string) {
  if (!root) return false;
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

import fs from "node:fs/promises";
import path from "node:path";

import type { SymbolRecord } from "./types.js";

export interface PsiCachePayload {
  schemaVersion: number;
  generatedAt?: string;
  projectName?: string;
  symbols: SymbolRecord[];
}

async function ensureDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadPsiCache(
  cachePath: string,
): Promise<PsiCachePayload | undefined> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PsiCachePayload>;
    if (!parsed || !Array.isArray(parsed.symbols)) {
      return undefined;
    }
    return {
      schemaVersion: Number(parsed.schemaVersion ?? 1),
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : undefined,
      projectName:
        typeof parsed.projectName === "string" ? parsed.projectName : undefined,
      symbols: parsed.symbols as SymbolRecord[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    console.warn("[idea-bridge] failed to read PSI cache:", error);
    return undefined;
  }
}

export async function savePsiCache(
  cachePath: string,
  payload: PsiCachePayload,
) {
  await ensureDir(cachePath);
  const serialized = JSON.stringify(payload, null, 2);
  await fs.writeFile(cachePath, serialized, "utf8");
}

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import MiniSearch from "minisearch";

import type { MethodInfo, SearchResult, SymbolRecord } from "./types.js";

const CLASS_REGEX =
  /(?:(\/\*\*[\s\S]*?\*\/)\s*)?((?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface)\s+(\w+)([\s\S]*?)\{/g;
const METHOD_REGEX =
  /(?:(\/\*\*[\s\S]*?\*\/)\s*)?((?:public|protected|private|static|final|abstract|synchronized|default|native|\s)+)?([\w<>\[\]?.]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws [^{]+)?\{/g;

interface BuildOptions {
  projectRoot: string;
  globPattern?: string;
}

export async function buildSymbolRecords({
  projectRoot,
  globPattern = "**/*.java",
}: BuildOptions): Promise<SymbolRecord[]> {
  const files = await fg(globPattern, {
    cwd: projectRoot,
    ignore: ["**/target/**", "**/.idea/**", "**/build/**"],
    absolute: true,
  });

  const records: SymbolRecord[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const perFileSymbols = extractSymbolsFromFile(content, filePath, projectRoot);
    records.push(...perFileSymbols);
  }

  return records;
}

function extractSymbolsFromFile(
  content: string,
  filePath: string,
  projectRoot: string,
): SymbolRecord[] {
  const packageMatch = content.match(/package\s+([\w.]+)\s*;/);
  const packageName = packageMatch ? packageMatch[1] : "";
  const relativePath = path.relative(projectRoot, filePath);
  const module = relativePath.split(path.sep)[0] ?? "";

  const symbols: SymbolRecord[] = [];
  for (const match of content.matchAll(CLASS_REGEX)) {
    const [, rawDoc, rawModifiers = "", kind, name] = match;
    const classStart = match.index ?? 0;
    const body = extractBlock(content, classStart);

    const modifiers = rawModifiers
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const headerSlice = match[5] ?? "";
    const extendsMatch = headerSlice.match(/extends\s+([\w.,\s<>?]+)/);
    const implementsMatch = headerSlice.match(/implements\s+([\w.,\s<>?]+)/);

    const methods = body ? extractMethods(body) : [];

    const summary = buildSummary({
      packageName,
      name,
      kind,
      extendsClause: extendsMatch?.[1],
      implementsClause: implementsMatch?.[1],
      methods,
      javadoc: rawDoc,
    });

    symbols.push({
      fqn: packageName ? `${packageName}.${name}` : name,
      kind: kind === "interface" ? "INTERFACE" : "CLASS",
      module,
      packageName,
      relativePath,
      filePath,
      summary,
      javadoc: cleanDoc(rawDoc),
      extends: extendsMatch?.[1]
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      implements: implementsMatch?.[1]
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      modifiers,
      methods,
    });
  }

  return symbols;
}

function extractBlock(content: string, startIndex: number): string | undefined {
  const braceStart = content.indexOf("{", startIndex);
  if (braceStart === -1) {
    return undefined;
  }

  let depth = 0;
  for (let i = braceStart; i < content.length; i += 1) {
    const char = content[i];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;

    if (depth === 0) {
      return content.slice(braceStart + 1, i);
    }
  }
  return undefined;
}

function extractMethods(body: string): MethodInfo[] {
  const methods: MethodInfo[] = [];
  for (const match of body.matchAll(METHOD_REGEX)) {
    const [, rawDoc, rawModifiers = "", returnType, name, params = ""] = match;
    const modifiers = rawModifiers
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const visibility =
      modifiers.find((token) =>
        ["public", "protected", "private"].includes(token),
      ) ?? "package-private";

    const parameters = params
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    methods.push({
      name,
      signature: `${returnType} ${name}(${params.trim()})`.trim(),
      visibility,
      returnType,
      parameters,
      javadoc: cleanDoc(rawDoc),
    });
  }
  return methods;
}

function cleanDoc(doc?: string | null) {
  if (!doc) return undefined;
  return doc
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("/**") && line !== "*/")
    .join(" ");
}

function buildSummary({
  packageName,
  name,
  kind,
  extendsClause,
  implementsClause,
  methods,
  javadoc,
}: {
  packageName: string;
  name: string;
  kind: string;
  extendsClause?: string;
  implementsClause?: string;
  methods: MethodInfo[];
  javadoc?: string | null;
}) {
  const summaryParts = [
    `${kind} ${packageName ? `${packageName}.` : ""}${name}`,
  ];

  if (extendsClause) summaryParts.push(`extends ${extendsClause.trim()}`);
  if (implementsClause) summaryParts.push(`implements ${implementsClause.trim()}`);
  if (javadoc) summaryParts.push(javadoc.trim());

  if (methods.length > 0) {
    const methodList = methods
      .slice(0, 5)
      .map((method) => method.signature.replace(/\s+/g, " "))
      .join("; ");
    summaryParts.push(`Key methods: ${methodList}`);
  }

  return summaryParts.join(". ");
}

export class SymbolIndex {
  private records: SymbolRecord[];
  private miniSearch: MiniSearch;

  constructor(records: SymbolRecord[]) {
    this.records = records;
    this.miniSearch = new MiniSearch({
      fields: ["fqn", "summary", "packageName", "module"],
      storeFields: ["fqn"],
      searchOptions: {
        boost: { fqn: 3, summary: 2, packageName: 1.5 },
        fuzzy: 0.2,
        prefix: true,
      },
    });

    this.miniSearch.addAll(
      records.map((record, idx) => ({
        id: idx,
        fqn: record.fqn,
        summary: record.summary,
        packageName: record.packageName,
        module: record.module,
      })),
    );
  }

  search(query: {
    query: string;
    limit?: number;
    module?: string;
  }): SearchResult[] {
    const limit = Math.min(Math.max(query.limit ?? 5, 1), 25);
    const hits = this.miniSearch.search(query.query);
    const results: SearchResult[] = [];

    for (const hit of hits) {
      const record = this.records[hit.id as number];
      if (!record) continue;
      if (query.module && record.module !== query.module) {
        continue;
      }
      results.push({ ...record, score: hit.score });
      if (results.length >= limit) break;
    }

    if (results.length === 0) {
      return this.records
        .filter((record) =>
          record.fqn.toLowerCase().includes(query.query.toLowerCase()),
        )
        .slice(0, limit)
        .map((record) => ({ ...record, score: 0.1 }));
    }

    return results;
  }

  listAll(): SymbolRecord[] {
    return this.records;
  }
}

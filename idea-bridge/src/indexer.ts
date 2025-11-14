import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import MiniSearch from "minisearch";

import type {
  AnnotationInfo,
  FieldInfo,
  MethodInfo,
  ParameterInfo,
  SearchResult,
  SymbolRecord,
} from "./types.js";

const CLASS_REGEX =
  /(?:(\/\*\*[\s\S]*?\*\/)\s*)?((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface)\s+(\w+)([\s\S]*?)\{/g;
const METHOD_REGEX =
  /(?:(\/\*\*[\s\S]*?\*\/)\s*)?((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|protected|private|static|final|abstract|synchronized|default|native|\s)+)?([\w<>\[\]?.]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws [^{]+)?\{/g;
const FIELD_REGEX =
  /(?:(\/\*\*[\s\S]*?\*\/)\s*)?((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|protected|private|static|final|transient|volatile)\s+)*([\w<>\[\]?.]+)\s+(\w+)\s*(?:[=;])/g;
const IMPORT_REGEX = /import\s+(?:static\s+)?([\w.*]+)\s*;/g;

const JAVA_LANG_TYPES = new Set([
  "String",
  "Object",
  "Long",
  "Integer",
  "Boolean",
  "Double",
  "Float",
  "Short",
  "Byte",
  "Character",
  "Void",
  "Math",
]);

const COLLECTION_TYPES = new Map([
  ["List", "java.util.List"],
  ["Set", "java.util.Set"],
  ["Map", "java.util.Map"],
  ["Optional", "java.util.Optional"],
  ["Collection", "java.util.Collection"],
  ["Iterable", "java.lang.Iterable"],
]);

const SPRING_BEAN_ANNOTATIONS = new Map([
  ["Service", "service"],
  ["Component", "component"],
  ["Repository", "repository"],
  ["Controller", "controller"],
  ["RestController", "rest-controller"],
]);

const SPRING_INJECTION_ANNOTATIONS = new Set([
  "Autowired",
  "Inject",
  "Resource",
]);

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

  const repoName = path.basename(projectRoot);
  const records: SymbolRecord[] = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const perFileSymbols = extractSymbolsFromFile(
      content,
      filePath,
      projectRoot,
      repoName,
    );
    records.push(...perFileSymbols);
  }

  return records;
}

function extractSymbolsFromFile(
  content: string,
  filePath: string,
  projectRoot: string,
  repoName: string,
): SymbolRecord[] {
  const packageMatch = content.match(/package\s+([\w.]+)\s*;/);
  const packageName = packageMatch ? packageMatch[1] : "";
  const relativePath = path.relative(projectRoot, filePath);
  const module = relativePath.split(path.sep)[0] ?? "";
  const modulePath = relativePath.includes(path.sep)
    ? relativePath.split(path.sep).slice(0, -1).join(path.sep)
    : ".";
  const importResolver = createImportResolver(content);

  const symbols: SymbolRecord[] = [];
  for (const match of content.matchAll(CLASS_REGEX)) {
    const [
      ,
      rawDoc,
      rawAnnotations = "",
      rawModifiers = "",
      kind,
      name,
      headerSlice,
    ] = match;

    const classStart = match.index ?? 0;
    const body = extractBlock(content, classStart);

    const modifiers = rawModifiers
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const extendsMatch = headerSlice.match(/extends\s+([\w.,\s<>?]+)/);
    const implementsMatch = headerSlice.match(/implements\s+([\w.,\s<>?]+)/);

    const annotations = parseAnnotations(rawAnnotations, importResolver);
    const methods = body
      ? extractMethods(body, importResolver, packageName)
      : [];
    const fields = body ? extractFields(body, importResolver) : [];

    const summary = buildSummary({
      packageName,
      name,
      kind,
      extendsClause: extendsMatch?.[1],
      implementsClause: implementsMatch?.[1],
      methods,
      javadoc: rawDoc,
    });

    const resolvedExtends = parseTypeList(
      extendsMatch?.[1],
      importResolver,
      packageName,
    );
    const resolvedImplements = parseTypeList(
      implementsMatch?.[1],
      importResolver,
      packageName,
    );

    const lineStart = getLineNumber(content, classStart);
    const lineEnd =
      lineStart + (body ? body.split(/\r?\n/).length : summary.split(".").length);

    symbols.push({
      repoName,
      fqn: packageName ? `${packageName}.${name}` : name,
      kind: kind === "interface" ? "INTERFACE" : "CLASS",
      module,
      modulePath,
      packageName,
      relativePath,
      filePath,
      summary,
      javadoc: cleanDoc(rawDoc),
      extends: resolvedExtends.map((item) => item.fqn ?? item.name),
      implements: resolvedImplements.map((item) => item.fqn ?? item.name),
      modifiers,
      annotations,
      imports: Array.from(importResolver.values()),
      methods,
      fields,
      typeInfo: deriveTypeInfo(kind, modifiers),
      dependencies: {
        imports: Array.from(importResolver.values()),
        extends: resolvedExtends.map((entry) => entry.fqn ?? entry.name),
        implements: resolvedImplements.map((entry) => entry.fqn ?? entry.name),
        fieldTypes: fields
          .map((field) => field.typeFqn ?? field.type)
          .filter(Boolean),
      },
      springInfo: deriveSpringInfo(annotations, fields),
      quality: {
        hasJavadoc: Boolean(rawDoc),
        methodCount: methods.length,
        fieldCount: fields.length,
        summaryLength: summary.length,
      },
      lineStart,
      lineEnd,
    });
  }

  return symbols;
}

function extractBlock(content: string, startIndex: number): string | undefined {
  const braceStart = content.indexOf("{", startIndex);
  if (braceStart === -1) return undefined;

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

function extractMethods(
  body: string,
  imports: Map<string, string>,
  packageName: string,
): MethodInfo[] {
  const methods: MethodInfo[] = [];
  for (const match of body.matchAll(METHOD_REGEX)) {
    const [, rawDoc, rawAnnotations = "", rawModifiers = "", returnType, name, params = ""] =
      match;
    const modifiers = rawModifiers
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const visibility =
      modifiers.find((token) =>
        ["public", "protected", "private"].includes(token),
      ) ?? "package-private";

    const parameters = parseParameters(params, imports, packageName);
    const resolvedReturn = resolveTypeReference(returnType, imports, packageName);

    methods.push({
      name,
      signature: `${returnType} ${name}(${params.trim()})`.trim(),
      visibility,
      returnType,
      returnTypeFqn: resolvedReturn?.fqn,
      parameters,
      annotations: parseAnnotations(rawAnnotations, imports),
      javadoc: cleanDoc(rawDoc),
    });
  }
  return methods;
}

function extractFields(body: string, imports: Map<string, string>): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const match of body.matchAll(FIELD_REGEX)) {
    const [, , rawAnnotations = "", rawModifiers = "", type, name] = match;

    const modifiers = rawModifiers
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);

    const resolvedType = resolveTypeReference(type, imports);

    fields.push({
      name,
      type,
      typeFqn: resolvedType?.fqn ?? resolvedType?.name,
      modifiers,
      annotations: parseAnnotations(rawAnnotations, imports),
    });
  }
  return fields;
}

function parseAnnotations(block: string, imports: Map<string, string>): AnnotationInfo[] {
  if (!block) return [];
  const annotations: AnnotationInfo[] = [];
  const regex = /@([\w.]+)(\([^)]*\))?/g;
  for (const match of block.matchAll(regex)) {
    const name = match[1];
    const resolved = resolveAnnotation(name, imports);
    annotations.push({
      name,
      fqn: resolved,
      arguments: match[2]?.slice(1, -1),
    });
  }
  return annotations;
}

function parseParameters(
  params: string,
  imports: Map<string, string>,
  packageName: string,
): ParameterInfo[] {
  if (!params.trim()) return [];
  return params
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const [typePart, namePart] = segment.split(/\s+(?=[^ ]+$)/);
      const resolved = resolveTypeReference(typePart ?? "", imports, packageName);
      return {
        name: namePart ?? "param",
        type: typePart ?? "Object",
        typeFqn: resolved?.fqn ?? resolved?.name,
      };
    });
}

function createImportResolver(content: string) {
  const map = new Map<string, string>();
  for (const match of content.matchAll(IMPORT_REGEX)) {
    const fqn = match[1];
    if (!fqn.endsWith(".*")) {
      const simple = fqn.split(".").pop();
      if (simple) map.set(simple, fqn);
    }
  }
  return map;
}

function resolveAnnotation(name: string, imports: Map<string, string>) {
  if (name.includes(".")) return name;
  return imports.get(name) ?? `unresolved:${name}`;
}

function resolveTypeReference(
  raw: string,
  imports: Map<string, string>,
  packageName?: string,
) {
  const clean = raw.replace(/[\[\]]/g, "").trim();
  if (!clean) return undefined;
  const base = clean.replace(/<.*>/g, "").split(/\s+/).pop() ?? clean;
  if (base.includes(".")) {
    return { name: base, fqn: base };
  }
  if (imports.has(base)) {
    return { name: base, fqn: imports.get(base) };
  }
  if (COLLECTION_TYPES.has(base)) {
    return { name: base, fqn: COLLECTION_TYPES.get(base) };
  }
  if (JAVA_LANG_TYPES.has(base)) {
    return { name: base, fqn: `java.lang.${base}` };
  }
  if (packageName) {
    return { name: base, fqn: `${packageName}.${base}` };
  }
  return { name: base };
}

function parseTypeList(
  clause: string | undefined,
  imports: Map<string, string>,
  packageName: string,
) {
  if (!clause) return [];
  return clause
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolveTypeReference(item, imports, packageName))
    .filter(Boolean) as { name: string; fqn?: string }[];
}

function deriveTypeInfo(kind: string, modifiers: string[]) {
  const visibility =
    modifiers.find((token) =>
      ["public", "protected", "private"].includes(token),
    ) ?? "package-private";
  return {
    visibility,
    isAbstract: modifiers.includes("abstract"),
    isFinal: modifiers.includes("final"),
    isInterface: kind === "interface",
    modifiers,
  };
}

function deriveSpringInfo(
  annotations: AnnotationInfo[],
  fields: FieldInfo[],
): SymbolRecord["springInfo"] {
  const beanAnnotation = annotations.find((ann) =>
    SPRING_BEAN_ANNOTATIONS.has(ann.name),
  );
  if (!beanAnnotation) return undefined;

  const autoWiredDependencies = fields
    .filter((field) =>
      field.annotations.some((ann) => SPRING_INJECTION_ANNOTATIONS.has(ann.name)),
    )
    .map((field) => field.typeFqn ?? field.type);

  return {
    isSpringBean: true,
    beanType: SPRING_BEAN_ANNOTATIONS.get(beanAnnotation.name),
    beanName: deriveBeanName(beanAnnotation.name),
    annotations: annotations.map((ann) => ann.fqn ?? ann.name),
    autoWiredDependencies,
  };
}

function deriveBeanName(annotationName: string) {
  const base = annotationName.replace(/Controller$/, "").replace(/Service$/, "");
  const first = base.charAt(0).toLowerCase();
  return `${first}${base.slice(1)}`;
}

function getLineNumber(content: string, index: number) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function cleanDoc(doc?: string | null) {
  if (!doc) return undefined;
  return (
    doc
      .split("\n")
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("/**") && line !== "*/")
      .join(" ") || undefined
  );
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

  search(query: { query: string; limit?: number; module?: string }): SearchResult[] {
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

import type { SymbolRecord } from "./types.js";

export type Role =
  | "ENTRYPOINT"
  | "DISCOVERY_CLIENT"
  | "DISCOVERY_SERVER"
  | "REST_CONTROLLER"
  | "REST_ENDPOINT"
  | "ENTITY"
  | "REPOSITORY"
  | "DTO"
  | "TEST"
  | "SPRING_BEAN"
  | "CONFIG"
  | "OTHER";

const ROLE_FROM_METADATA = new Map<string, Role>([
  ["ENTRYPOINT", "ENTRYPOINT"],
  ["DISCOVERY_CLIENT", "DISCOVERY_CLIENT"],
  ["DISCOVERY_SERVER", "DISCOVERY_SERVER"],
  ["REST_CONTROLLER", "REST_CONTROLLER"],
  ["REST_ENDPOINT", "REST_ENDPOINT"],
  ["ENTITY", "ENTITY"],
  ["REPOSITORY", "REPOSITORY"],
  ["DTO", "DTO"],
  ["TEST", "TEST"],
  ["SPRING_BEAN", "SPRING_BEAN"],
  ["CONFIG", "CONFIG"],
]);

const ANNOTATION_ROLE_MATCHERS: [RegExp, Role][] = [
  [/springbootapplication$/, "ENTRYPOINT"],
  [/enablediscoveryclient$/, "DISCOVERY_CLIENT"],
  [/enableeurekaclient$/, "DISCOVERY_CLIENT"],
  [/enableeurekaserver$/, "DISCOVERY_SERVER"],
  [/(rest)?controller$/, "REST_CONTROLLER"],
  [/requestmapping$/, "REST_ENDPOINT"],
  [/getmapping$/, "REST_ENDPOINT"],
  [/postmapping$/, "REST_ENDPOINT"],
  [/putmapping$/, "REST_ENDPOINT"],
  [/deletemapping$/, "REST_ENDPOINT"],
  [/component$/, "SPRING_BEAN"],
  [/service$/, "SPRING_BEAN"],
  [/repository$/, "REPOSITORY"],
  [/configuration$/, "CONFIG"],
];

export function inferRoles(symbol: SymbolRecord): Role[] {
  const roles = new Set<Role>();
  const annotations = collectAnnotations(symbol);
  const lowerFqn = symbol.fqn.toLowerCase();
  const simpleName = getSimpleName(symbol.fqn);
  const metadataRole = extractMetadataRole(symbol);
  if (metadataRole) {
    roles.add(metadataRole);
  }

  for (const annotation of annotations) {
    for (const [regex, role] of ANNOTATION_ROLE_MATCHERS) {
      if (regex.test(annotation)) {
        roles.add(role);
      }
    }
  }

  if (/test/i.test(symbol.fqn) || isTestPath(symbol)) {
    roles.add("TEST");
  }
  if (/repository/i.test(simpleName) || /mapper$/i.test(simpleName)) {
    roles.add("REPOSITORY");
  }
  if (/controller$/i.test(simpleName)) {
    roles.add("REST_CONTROLLER");
  }
  if (/dto$/i.test(simpleName) || /\bdto\b/i.test(simpleName)) {
    roles.add("DTO");
  }
  if (/config$/i.test(simpleName)) {
    roles.add("CONFIG");
  }
  if (/service$/i.test(simpleName)) {
    roles.add("SPRING_BEAN");
  }
  if (/entity|domain|model/i.test(symbol.fqn) || isEntityPath(symbol)) {
    roles.add("ENTITY");
  }
  if (symbol.kind === "METHOD") {
    const methodAnnotations = annotations;
    if (methodAnnotations.some((ann) => /mapping$/.test(ann))) {
      roles.add("REST_ENDPOINT");
    }
  }
  if (roles.size === 0) {
    roles.add("OTHER");
  }
  return Array.from(roles);
}

function collectAnnotations(symbol: SymbolRecord): string[] {
  const annotations: string[] = [];
  const metadata = symbol.metadata ?? {};
  const raw = (metadata.annotations as string[]) ?? [];
  const springAnnotations = symbol.springInfo?.annotations ?? [];
  for (const list of [raw, springAnnotations]) {
    for (const entry of list ?? []) {
      annotations.push(String(entry).toLowerCase());
    }
  }
  return annotations;
}

function getSimpleName(fqn: string): string {
  const parts = fqn.split(".");
  return parts[parts.length - 1] ?? fqn;
}

function extractMetadataRole(symbol: SymbolRecord): Role | undefined {
  const metadata = symbol.metadata ?? {};
  const rawRole = (metadata.role as string) ?? undefined;
  if (!rawRole) return undefined;
  const normalized = rawRole.toUpperCase();
  return ROLE_FROM_METADATA.get(normalized);
}

function isTestPath(symbol: SymbolRecord): boolean {
  const path = (symbol.metadata?.filePath as string) ?? symbol.modulePath ?? "";
  return /\/test\//i.test(path);
}

function isEntityPath(symbol: SymbolRecord): boolean {
  const path = (symbol.metadata?.filePath as string) ?? symbol.modulePath ?? "";
  return /(entity|model|domain)/i.test(path);
}

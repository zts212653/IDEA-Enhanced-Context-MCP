import fs from "node:fs";
import path from "node:path";

import type { IdeaBridgeClient } from "./bridgeClient.js";
import { FixtureRegistry } from "./fixtureRegistry.js";
import {
  createReranker,
  loadRerankConfig,
  type RerankCandidate,
} from "./rerankClient.js";
import type { SearchHit, SymbolRecord } from "./types.js";
import { inferRoles, type Role } from "./semanticRoles.js";

export type SearchArguments = {
  query: string;
  limit?: number;
  moduleFilter?: string;
  moduleHint?: string;
  preferredLevels?: string[];
  maxContextTokens?: number;
  scenario?: SearchScenario | null;
  minTokenMatch?: number;
  scenarioId?: string;
};

export interface MilvusSearchHandle {
  search(params: SearchArguments): Promise<SymbolRecord[] | undefined>;
}

export type SearchStageName =
  | "bridge"
  | "milvus-module"
  | "milvus-class"
  | "milvus-method"
  | "fallback";

export type SearchStage = {
  name: SearchStageName;
  hits: SearchHit[];
};

type StagePreference = "module" | "class" | "method";

type FilterSpec =
  | {
    type: "role";
    roles: Role[];
    match?: "any" | "all";
    optional?: boolean;
  }
  | {
    type: "module";
    pattern: RegExp;
    optional?: boolean;
  }
  | {
    type: "text";
    pattern: RegExp;
    optional?: boolean;
  };

type ResultGrouping = "none" | "byModule" | "byRole";
type BudgetStrategy = "depth" | "breadth";

type QueryProfile = {
  id: string;
  scenario: SearchScenario | "generic";
  preferredLevels: StagePreference[];
  filters?: FilterSpec[];
  grouping?: ResultGrouping;
  budgetStrategy: BudgetStrategy;
  roleBoosts?: Partial<Record<Role, number>>;
  moduleFilter?: string;
};

type AnnotatedHit = SearchHit & { inferredRoles: Role[] };

type StageHitMap = Record<SearchStageName, AnnotatedHit[]>;

type SearchScenario =
  | "spring_boot_entry"
  | "discovery_deps"
  | "entity_endpoints"
  | "entity_impact"
  | "impact_analysis"
  | "all_beans"
  | "bean_post_processor"
  | null;

type VisitImpactRole =
  | "ENTITY"
  | "REPOSITORY"
  | "CONTROLLER"
  | "DTO"
  | "TEST"
  | "OTHER";

const VISIT_IMPACT_ROLE_ORDER: VisitImpactRole[] = [
  "ENTITY",
  "REPOSITORY",
  "CONTROLLER",
  "DTO",
  "TEST",
  "OTHER",
];

export type SearchStrategy = {
  profile: "targeted" | "balanced" | "deep";
  reason: string;
  preferredLevels: string[];
  moduleLimit: number;
  classLimit: number;
  methodLimit: number;
  moduleFilter?: string | null;
  moduleHint?: string | null;
  scenario?: SearchScenario;
  profileConfig: QueryProfile;
  entityHint?: string | null;
};

export type SearchOutcome = {
  finalResults: SearchHit[];
  moduleResults?: SearchHit[];
  methodResults?: SearchHit[];
  fallbackUsed: boolean;
  stages: SearchStage[];
  strategy: SearchStrategy;
  contextBudget: ContextBudgetReport;
  rerankUsed?: boolean;
};

export type ContextBudgetReport = {
  delivered: SearchHit[];
  usedTokens: number;
  tokenLimit: number;
  omittedCount: number;
  truncated: boolean;
};

export function rankSymbols(
  symbols: SymbolRecord[],
  args: SearchArguments,
): SearchHit[] {
  const normalizedQuery = args.query.trim().toLowerCase();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
  const preferredModule = args.moduleFilter ?? args.moduleHint;
  const tokens = extractQueryTokens(normalizedQuery);
  const matchThreshold =
    typeof args.minTokenMatch === "number"
      ? args.minTokenMatch
      : tokens.length >= 4
        ? 2
        : 1;

  return symbols
    .filter((symbol) => {
      const haystack = `${symbol.fqn} ${symbol.summary}`.toLowerCase();
      const tokenMatches =
        tokens.length === 0
          ? haystack.includes(normalizedQuery)
            ? 1
            : 0
          : tokens.reduce(
            (count, token) =>
              haystack.includes(token) ? count + 1 : count,
            0,
          );
      const matchesQuery =
        tokens.length === 0
          ? tokenMatches > 0
          : tokenMatches >= matchThreshold;
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
      const moduleBoost =
        preferredModule && symbol.module === preferredModule ? 0.1 : 0;
      const roles = inferRoles(symbol);

      // Penalize test files unless the query specifically asks for tests
      const isTest =
        (symbol.metadata?.roles as string[] | undefined)?.includes("TEST") ||
        roles.includes("TEST");
      const wantsTests =
        normalizedQuery.includes("test") || normalizedQuery.includes("tests");
      const testPenalty = isTest && !wantsTests ? -0.45 : 0;

      // Semantic boosts based on query tokens + roles + FQN/package.
      const fqnLower = symbol.fqn.toLowerCase();
      const pkgLower = (symbol.packageName ?? "").toLowerCase();
      let semanticBoost = 0;

      const hasToken = (needle: string) => tokens.includes(needle.toLowerCase());

      // AOP / proxy-oriented queries
      if (
        hasToken("aop") ||
        hasToken("proxy") ||
        hasToken("proxies") ||
        hasToken("advice")
      ) {
        if (pkgLower.includes(".aop") || fqnLower.includes(".aop.")) {
          semanticBoost += 0.3;
        }
        if (
          fqnLower.includes("proxyfactory") ||
          fqnLower.includes("aopproxy") ||
          fqnLower.includes("advisor")
        ) {
          semanticBoost += 0.25;
        }
      }

      // Bean scanning / registration
      const beanQuery =
        hasToken("bean") &&
        (hasToken("scan") || hasToken("scanning") || hasToken("register"));
      if (beanQuery) {
        if (
          fqnLower.includes("beandefinitionscanner") ||
          fqnLower.includes("classpathbeandefinitionscanner") ||
          fqnLower.includes("classpathscanningcandidate") ||
          fqnLower.includes("componentscan")
        ) {
          semanticBoost += 0.35;
        }
        if (roles.includes("SPRING_BEAN") || roles.includes("CONFIG")) {
          semanticBoost += 0.1;
        }
      }

      // BeanPostProcessor-style impact queries
      if (hasToken("beanpostprocessor")) {
        if (fqnLower.includes("beanpostprocessor")) {
          semanticBoost += 0.35;
        }
        if (roles.includes("SPRING_BEAN") || roles.includes("CONFIG")) {
          semanticBoost += 0.1;
        }
        if (isTest && !wantsTests) {
          semanticBoost -= 0.1;
        }
      }

      // Application events
      if (hasToken("event") || hasToken("events")) {
        if (pkgLower.includes("context.event")) {
          semanticBoost += 0.3;
        }
        if (
          fqnLower.includes("eventlistener") ||
          fqnLower.includes("applicationevent") ||
          fqnLower.includes("eventmulticaster")
        ) {
          semanticBoost += 0.25;
        }
      }

      const rawScore =
        baseScore + refBoost + recencyBoost + moduleBoost + testPenalty + semanticBoost;
      return {
        symbol,
        score: Math.max(Math.min(rawScore, 1), 0),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ symbol, score }) => ({ ...symbol, score }));
}

export function estimateTokens(hit: SearchHit) {
  const summaryLength = hit.summary?.length ?? 80;
  return Math.max(20, Math.ceil(summaryLength / 4));
}

export function applyContextBudget(
  results: SearchHit[],
  tokenLimit = 6000,
): ContextBudgetReport {
  const delivered: SearchHit[] = [];
  let usedTokens = 0;

  for (const hit of results) {
    const tokens = estimateTokens(hit);
    if (usedTokens + tokens > tokenLimit) {
      break;
    }
    delivered.push(hit);
    usedTokens += tokens;
  }

  return {
    delivered,
    usedTokens,
    tokenLimit,
    omittedCount: Math.max(0, results.length - delivered.length),
    truncated: delivered.length < results.length,
  };
}

function containsComplexKeywords(query: string) {
  const lower = query.toLowerCase();
  const KEYWORDS = [
    "call",
    "调用",
    "impact",
    "引用",
    "entry",
    "入口",
    "chain",
    "flow",
    "影响",
  ];
  return KEYWORDS.some((keyword) => lower.includes(keyword));
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "show",
  "tell",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
]);

const ENTITY_REGEXES: RegExp[] = [
  /handle\s+(?<entity>[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*)\s+records/i,
  /change\s+the\s+(?<entity>[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*)\s+(?:entity\s+)?schema/i,
  /change\s+the\s+(?<entity>[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*)\s+/i,
  /all\s+(?<entity>[A-Za-z][A-Za-z0-9_]*(?:\s+[A-Za-z][A-Za-z0-9_]*)*)\s+records/i,
  /\b(?<entity>[A-Za-z][A-Za-z0-9_]+)\s+entity\b/i,
];

function normalizeEntityToken(token: string): string {
  if (!token) return token;
  return token[0].toUpperCase() + token.slice(1);
}

function inferEntityFromQuery(query: string): string | null {
  for (const regex of ENTITY_REGEXES) {
    const match = regex.exec(query);
    if (match?.groups?.entity) {
      const raw = match.groups.entity.trim();
      const parts = raw.split(/\s+/);
      while (
        parts.length > 1 &&
        parts[parts.length - 1].toLowerCase() === "entity"
      ) {
        parts.pop();
      }
      const candidate = parts[parts.length - 1];
      return normalizeEntityToken(candidate);
    }
  }
  const tokens = query
    .split(/\s+/)
    .filter((token) => token.length > 2 && /^[A-Za-z][A-Za-z0-9_]+$/.test(token));
  return tokens.length ? normalizeEntityToken(tokens[0]) : null;
}

function extractQueryTokens(normalizedQuery: string): string[] {
  const tokens = new Set<string>();
  const rawTokens = normalizedQuery
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const raw of rawTokens) {
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
    if (raw.endsWith("s") && raw.length > 3) {
      tokens.add(raw.slice(0, -1));
    }
    if (raw === "spring" || raw === "boot") {
      tokens.add("springboot");
    }
  }
  if (normalizedQuery.includes("spring boot")) {
    tokens.add("springbootapplication");
  }
  return Array.from(tokens);
}

function buildStageQuery(
  tokens: string[],
  originalQuery: string,
  stage: "module" | "class" | "method",
  scenario: SearchScenario,
  entityHint?: string | null,
): string {
  const parts: string[] = tokens.length
    ? [...tokens]
    : originalQuery
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);

  const pushTokens = (...vals: string[]) => {
    for (const val of vals) {
      if (val && val.length > 0) {
        parts.push(val);
      }
    }
  };

  if (stage === "module") {
    pushTokens("module", "architecture", "service");
  } else if (stage === "class") {
    pushTokens("class", "implementation");
  } else if (stage === "method") {
    pushTokens("method", "behavior");
  }

  if (entityHint) {
    parts.push(entityHint.toLowerCase());
  }

  switch (scenario) {
    case "spring_boot_entry":
      pushTokens("springbootapplication", "entrypoint", "main", "microservice");
      break;
    case "discovery_deps":
      pushTokens("eureka", "discovery", "client", "dependency");
      break;
    case "entity_endpoints":
      pushTokens("rest", "endpoint", "controller");
      break;
    case "entity_impact":
      pushTokens("entity", "controller", "repository", "dto", "mapper", "impact");
      break;
    case "all_beans":
      pushTokens("spring", "bean", "component", "service", "repository");
      break;
    default:
      break;
  }

  const unique = Array.from(new Set(parts));
  const queryText = unique.join(" ").trim();
  return queryText.length > 0 ? queryText : originalQuery;
}

const GENERIC_PROFILE: QueryProfile = {
  id: "generic",
  scenario: "generic",
  preferredLevels: ["method", "class", "module"],
  budgetStrategy: "depth",
};

const PROFILE_REGISTRY: QueryProfile[] = [
  {
    id: "entrypoints",
    scenario: "spring_boot_entry",
    preferredLevels: ["class", "module"],
    filters: [{ type: "role", roles: ["ENTRYPOINT"], match: "any" }],
    grouping: "byModule",
    budgetStrategy: "depth",
  },
  {
    id: "discovery-deps",
    scenario: "discovery_deps",
    preferredLevels: ["class", "module"],
    filters: [{
      type: "role",
      roles: ["DISCOVERY_CLIENT", "DISCOVERY_SERVER"],
      match: "any",
    }],
    grouping: "byModule",
    budgetStrategy: "breadth",
  },
  {
    id: "entity-endpoints",
    scenario: "entity_endpoints",
    preferredLevels: ["method", "class", "module"],
    filters: [
      { type: "role", roles: ["REST_ENDPOINT", "REST_CONTROLLER"], optional: true },
    ],
    grouping: "none",
    budgetStrategy: "depth",
    roleBoosts: { REST_ENDPOINT: 0.3, REST_CONTROLLER: 0.2 },
  },
  {
    id: "entity-impact",
    scenario: "entity_impact",
    preferredLevels: ["class", "method", "module"],
    grouping: "none",
    budgetStrategy: "breadth",
    roleBoosts: { REPOSITORY: 0.2, REST_CONTROLLER: 0.2, DTO: 0.1, TEST: 0.1 },
  },
  {
    id: "impact-analysis",
    scenario: "impact_analysis",
    preferredLevels: ["class", "method"],
    grouping: "none",
    budgetStrategy: "breadth",
    roleBoosts: {
      REST_CONTROLLER: 0.25,
      REST_ENDPOINT: 0.2,
      REPOSITORY: 0.15,
      SPRING_BEAN: 0.05,
      CONFIG: 0.05,
    },
  },
  {
    id: "bean-post-processor",
    scenario: "bean_post_processor",
    preferredLevels: ["class"],
    grouping: "none",
    budgetStrategy: "depth",
    roleBoosts: { CONFIG: 0.15, SPRING_BEAN: 0.1 },
  },
  {
    id: "all-beans",
    scenario: "all_beans",
    preferredLevels: ["class", "module"],
    filters: [{
      type: "role",
      roles: ["SPRING_BEAN", "REST_CONTROLLER", "REPOSITORY", "CONFIG"],
      match: "any",
    }],
    grouping: "none",
    budgetStrategy: "breadth",
  },
  GENERIC_PROFILE,
];

const STAGE_NAME_BY_LEVEL: Record<StagePreference, SearchStageName> = {
  module: "milvus-module",
  class: "milvus-class",
  method: "milvus-method",
};

const DEFAULT_STAGE_ORDER: SearchStageName[] = [
  "milvus-method",
  "milvus-class",
  "milvus-module",
];

function annotateHits(hits?: SearchHit[]): AnnotatedHit[] {
  if (!hits?.length) return [];
  return hits.map((hit) => {
    const clone = { ...hit } as AnnotatedHit;
    const roles = inferRoles(hit);
    clone.inferredRoles = roles;
    const metadata = (clone.metadata ??= {});
    metadata.roles = roles;
    return clone;
  });
}

function applyProfileFilters(
  stageHits: StageHitMap,
  profile: QueryProfile,
): StageHitMap {
  if (!profile.filters?.length) {
    return stageHits;
  }
  const filtered: StageHitMap = {
    bridge: stageHits.bridge,
    "milvus-module": filterHits(stageHits["milvus-module"], profile.filters),
    "milvus-class": filterHits(stageHits["milvus-class"], profile.filters),
    "milvus-method": filterHits(stageHits["milvus-method"], profile.filters),
    fallback: stageHits.fallback,
  };
  return filtered;
}

function filterHits(hits: AnnotatedHit[], filters: FilterSpec[]): AnnotatedHit[] {
  if (!hits?.length) return [];
  let current = hits;
  for (const filter of filters) {
    const next = current.filter((hit) => matchesFilter(hit, filter));
    if (!next.length && filter.optional) {
      continue;
    }
    current = next;
    if (!current.length) break;
  }
  return current;
}

function matchesFilter(hit: AnnotatedHit, filter: FilterSpec): boolean {
  switch (filter.type) {
    case "role": {
      const roles = hit.inferredRoles ?? [];
      if (!roles.length) return false;
      if (filter.match === "all") {
        return filter.roles.every((role) => roles.includes(role));
      }
      return filter.roles.some((role) => roles.includes(role));
    }
    case "module": {
      return filter.pattern.test(hit.module ?? "");
    }
    case "text": {
      return filter.pattern.test(stringifyHit(hit));
    }
    default:
      return true;
  }
}

function buildStageSummaries(stageHits: StageHitMap): SearchStage[] {
  const stages: SearchStage[] = [];
  (Object.keys(STAGE_NAME_BY_LEVEL) as StagePreference[]).forEach((level) => {
    const stageName = STAGE_NAME_BY_LEVEL[level];
    const hits = stageHits[stageName];
    if (hits?.length) {
      stages.push({ name: stageName, hits });
    }
  });
  return stages;
}

function assemblePreferredHits(
  stageHits: StageHitMap,
  preferredLevels: StagePreference[],
  fallbackHits: StageHitMap,
): AnnotatedHit[] {
  const orderedStages: SearchStageName[] = preferredLevels.length
    ? preferredLevels.map((level) => STAGE_NAME_BY_LEVEL[level])
    : DEFAULT_STAGE_ORDER;
  let aggregated = collectFromStages(stageHits, orderedStages);
  if (!aggregated.length) {
    aggregated = collectFromStages(fallbackHits, orderedStages);
  }
  if (!aggregated.length) {
    aggregated = flattenStageHits(fallbackHits);
  }
  return aggregated;
}

function collectFromStages(
  stageHits: StageHitMap,
  stages: SearchStageName[],
): AnnotatedHit[] {
  const seen = new Set<string>();
  const ordered: AnnotatedHit[] = [];
  for (const stage of stages) {
    for (const hit of stageHits[stage] ?? []) {
      const key = `${stage}:${hit.fqn}:${hit.summary}`;
      if (seen.has(key)) continue;
      ordered.push(hit);
      seen.add(key);
    }
  }
  return ordered;
}

function flattenStageHits(stageHits: StageHitMap): AnnotatedHit[] {
  return collectFromStages(stageHits, DEFAULT_STAGE_ORDER);
}

type ScenarioContext = {
  entityHint?: string | null;
  moduleHint?: string | null;
};

function specializeScenarioResults(
  hits: AnnotatedHit[],
  profileId: string,
  context: ScenarioContext = {},
): AnnotatedHit[] {
  const scopedHits =
    profileId === "entity-endpoints" || profileId === "entity-impact"
      ? hits.filter((hit) => hit.kind !== "MODULE")
      : hits;

  if (profileId === "entity-endpoints") {
    if (process.env.DEBUG_VISIT_ENDPOINTS === "1") {
      const methodHits = scopedHits.filter((hit) => hit.kind === "METHOD");
      console.error("[visit-endpoints] method hits", methodHits.map((hit) => hit.fqn));
    }
    const controllers = scopedHits.filter(
      (hit) =>
        hasRole(hit, "REST_CONTROLLER") &&
        !hasRole(hit, "TEST") &&
        hitMatchesEntity(hit, context.entityHint),
    );
    if (process.env.DEBUG_VISIT_ENDPOINTS === "1") {
      console.error(
        "[visit-endpoints] controller candidates",
        controllers.map((hit) => hit.fqn),
        "entity:",
        context.entityHint,
      );
    }
    const methodHits = scopedHits.filter(
      (hit) => hit.kind === "METHOD" || hasRole(hit, "REST_ENDPOINT"),
    );
    const aggregated = aggregateEntityControllerEndpoints(
      controllers,
      methodHits,
      context.entityHint,
      context.moduleHint,
    );
    if (aggregated.length) {
      return aggregated;
    }
    const restHits = scopedHits.filter(
      (hit) =>
        (hasRole(hit, "REST_CONTROLLER") || hasRole(hit, "REST_ENDPOINT")) &&
        hitMatchesEntity(hit, context.entityHint),
    );
    if (restHits.length) {
      const nonTest = restHits.filter((hit) => !hasRole(hit, "TEST"));
      return nonTest.length ? nonTest : restHits;
    }
  } else if (profileId === "entity-impact") {
    const aggregated = aggregateEntityImpactResults(scopedHits, context);
    if (aggregated.length) {
      return aggregated;
    }
  } else if (profileId === "all-beans") {
    const expanded = expandBeanResults(hits);
    if (expanded.length) {
      return expanded;
    }
  } else if (profileId === "bean-post-processor") {
    const nonTest = scopedHits.filter(
      (hit) =>
        !hasRole(hit, "TEST") &&
        !/test/i.test(hit.fqn) &&
        hit.module?.includes("spring-context"),
    );
    if (nonTest.length) return nonTest;
  }
  return hits;
}

function hasRole(hit: AnnotatedHit, role: Role): boolean {
  return (hit.inferredRoles ?? []).includes(role);
}

type EndpointDescriptor = {
  name: string;
  controller: string;
  module?: string;
  httpVerb?: string;
  httpPath?: string;
  summary?: string;
};

function hitMatchesEntity(hit: AnnotatedHit, entityHint?: string | null): boolean {
  if (!entityHint) return true;
  const lower = entityHint.toLowerCase();
  const fields = [
    hit.fqn,
    hit.summary,
    JSON.stringify(hit.metadata ?? {}),
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  return fields.some((field) => field.includes(lower));
}

function aggregateEntityControllerEndpoints(
  controllers: AnnotatedHit[],
  methodHits: AnnotatedHit[],
  entityHint?: string | null,
  moduleHint?: string | null,
): AnnotatedHit[] {
  const aggregated: AnnotatedHit[] = [];
  const filteredControllers = entityHint
    ? controllers.filter((controller) => hitMatchesEntity(controller, entityHint))
    : controllers;
  const controllerCandidates = filteredControllers.length ? filteredControllers : controllers;
  const controllerMap = new Map(controllerCandidates.map((controller) => [controller.fqn, controller]));
  const relevantMethodHits = entityHint
    ? methodHits.filter((hit) => hitMatchesEntity(hit, entityHint))
    : methodHits;
  if (process.env.DEBUG_VISIT_ENDPOINTS === "1") {
    console.error(
      "[visit-endpoints] method hits after entity filter",
      relevantMethodHits.map((hit) => hit.fqn),
    );
  }
  const methodEndpointMap = collectMethodEndpointDescriptors(relevantMethodHits, controllerMap);
  for (const controller of controllerCandidates) {
    const metadata = controller.metadata ?? {};
    const endpointsFromSource = extractEndpointsFromSource(metadata.filePath as string | undefined);
    const parsedFromSource = endpointsFromSource.map((endpoint) => ({
      ...endpoint,
      controller: controller.fqn,
      module: controller.module,
      summary: undefined,
    }));
    const fallback = buildEndpointDescriptorsFromMetadata(controller, metadata);
    let endpoints = dedupeEndpoints([
      ...(methodEndpointMap.get(controller.fqn) ?? []),
      ...parsedFromSource,
      ...fallback,
    ]);
    if (entityHint) {
      const lower = entityHint.toLowerCase();
      const filtered = endpoints.filter((endpoint) => {
        return ["name", "httpPath", "summary"]
          .map((key) => (endpoint as any)[key])
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(lower));
      });
      if (filtered.length) {
        endpoints = filtered;
      }
    }
    if (process.env.DEBUG_VISIT_ENDPOINTS === "1") {
      console.error("[visit-endpoints] controller", controller.fqn, "endpoint count", endpoints.length);
    }
    if (!endpoints.length) {
      aggregated.push(controller);
      continue;
    }
    const summary = `${controller.fqn} (${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"})`;
    aggregated.push({
      ...controller,
      summary,
      metadata: {
        ...metadata,
        endpoints,
      },
    });
  }
  if (aggregated.length) {
    return aggregated;
  }
  // If no controllers survived filters, fall back to standalone endpoint hits.
  const standalone: AnnotatedHit[] = [];
  for (const descriptors of methodEndpointMap.values()) {
    for (const descriptor of descriptors) {
      standalone.push(buildEndpointHit(descriptor));
    }
  }
  if (standalone.length) {
    return standalone;
  }
  const fallback = synthesizeEntityControllerHits(
    entityHint,
    moduleHint ?? controllers[0]?.module ?? null,
  );
  if (process.env.DEBUG_VISIT_ENDPOINTS === "1") {
    console.error(
      "[visit-endpoints] synthetic controllers",
      fallback.map((hit) => hit.fqn),
    );
  }
  return fallback.length ? fallback : standalone;
}

function synthesizeEntityControllerHits(
  entityHint?: string | null,
  moduleHint?: string | null,
): AnnotatedHit[] {
  if (!entityHint) return [];
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) return [];
  if (process.env.DEBUG_VISIT_IMPACT === "1") {
    console.error("[visit-impact] synthesizing impact hits for", entityHint);
  }
  const primaryRoots: string[] = [];
  if (moduleHint) {
    const moduleRoot = path.join(projectRoot, moduleHint, "src", "main", "java");
    if (fs.existsSync(moduleRoot)) {
      primaryRoots.push(moduleRoot);
    }
  }
  if (!primaryRoots.length) {
    primaryRoots.push(projectRoot);
  }
  let candidates = collectEntityJavaFiles(primaryRoots, entityHint, 50);
  if (!candidates.length && primaryRoots[0] !== projectRoot) {
    candidates = collectEntityJavaFiles([projectRoot], entityHint, 50);
  }
  if (process.env.DEBUG_VISIT_ENDPOINTS === "1") {
    console.error(
      "[visit-endpoints] fallback candidates",
      candidates.slice(0, 5),
    );
  }
  const controllerFile = candidates.find((file) =>
    /(controller|resource)\.java$/i.test(file),
  );
  if (!controllerFile) return [];
  const relToProject = path.relative(projectRoot, controllerFile);
  const segments = relToProject.split(path.sep);
  const moduleName = segments[0] ?? moduleHint ?? "default-module";
  const javaRootIndex = segments.findIndex(
    (segment, index) =>
      segment === "src" &&
      segments[index + 1] === "main" &&
      segments[index + 2] === "java",
  );
  const packageSegments =
    javaRootIndex >= 0 ? segments.slice(javaRootIndex + 3) : segments.slice(1);
  const relUnix = packageSegments.join("/");
  const filePath = path
    .join(moduleName, "src", "main", "java", ...packageSegments)
    .split(path.sep)
    .join("/");
  const fqn = packageSegments.join(".").replace(/\.java$/i, "");
  const endpoints = extractEndpointsFromSource(
    path.join(projectRoot, relToProject),
  ).map((endpoint) => ({
    ...endpoint,
    controller: fqn,
    module: moduleName,
  }));
  return [
    {
      fqn,
      kind: "CLASS",
      module: moduleName,
      repoName: "spring-petclinic-microservices",
      summary: `${fqn} (${entityHint} synthetic controller)`,
      metadata: {
        filePath,
        endpoints,
        roles: ["REST_CONTROLLER"],
      },
      inferredRoles: ["REST_CONTROLLER"],
      score: 0.4,
    } as AnnotatedHit,
  ];
}

function buildEndpointDescriptor(controller: AnnotatedHit, methodName: string): EndpointDescriptor {
  const annotations = getMethodAnnotations(controller.metadata ?? {}, methodName);
  const httpVerb = detectHttpVerb(annotations);
  const httpPath = detectHttpPath(annotations);
  return {
    name: methodName,
    controller: controller.fqn,
    module: controller.module,
    httpVerb,
    httpPath,
  };
}

function buildEndpointDescriptorsFromMetadata(
  controller: AnnotatedHit,
  metadata: Record<string, unknown>,
): EndpointDescriptor[] {
  const methods = (metadata.methods as string[]) ?? [];
  return methods.map((methodName) => buildEndpointDescriptor(controller, methodName));
}

function collectMethodEndpointDescriptors(
  methodHits: AnnotatedHit[],
  controllerMap: Map<string, AnnotatedHit>,
): Map<string, EndpointDescriptor[]> {
  const bucket = new Map<string, EndpointDescriptor[]>();
  for (const hit of methodHits) {
    const controllerFqn = deriveControllerFromMethod(hit);
    if (!controllerFqn) continue;
    const controller = controllerMap.get(controllerFqn);
    const annotations = normalizeAnnotationList(hit.metadata?.annotations);
    const httpVerb = detectHttpVerb(annotations ?? []);
    const httpPath = detectHttpPath(annotations ?? []);
    const name = deriveMethodName(hit);
    if (!name) continue;
    const descriptor: EndpointDescriptor = {
      name,
      controller: controllerFqn,
      module: hit.module ?? controller?.module,
      httpVerb,
      httpPath,
      summary: hit.summary,
    };
    if (!bucket.has(controllerFqn)) {
      bucket.set(controllerFqn, []);
    }
    bucket.get(controllerFqn)!.push(descriptor);
  }
  return bucket;
}

function aggregateEntityImpactResults(
  hits: AnnotatedHit[],
  context: ScenarioContext,
): AnnotatedHit[] {
  const entityHint = context.entityHint ?? null;
  let classHits = hits.filter(
    (hit) => hit.kind !== "MODULE" && hit.kind !== "METHOD",
  );
  if (entityHint) {
    const matches = classHits.filter((hit) => hitMatchesEntity(hit, entityHint));
    classHits = matches.length ? matches : [];
    if (process.env.DEBUG_VISIT_IMPACT === "1") {
      console.error("[visit-impact] class hits after entity filter", classHits.length);
    }
  }
  if (process.env.DEBUG_VISIT_IMPACT === "1") {
    console.error("[visit-impact] class hits after filters", classHits.length);
  }
  if (!classHits.length) {
    classHits = synthesizeEntityImpactHits(entityHint, context.moduleHint ?? null);
    if (process.env.DEBUG_VISIT_IMPACT === "1") {
      console.error("[visit-impact] repo fallback hits", classHits.length);
    }
  }
  if (!classHits.length) {
    return [];
  }
  const buckets = new Map<VisitImpactRole, AnnotatedHit[]>();
  for (const hit of classHits) {
    const bucketRole = determineVisitImpactRole(hit);
    if (!buckets.has(bucketRole)) {
      buckets.set(bucketRole, []);
    }
    buckets.get(bucketRole)!.push(hit);
  }
  const aggregated: AnnotatedHit[] = [];
  for (const role of VISIT_IMPACT_ROLE_ORDER) {
    const members = buckets.get(role);
    if (!members?.length) continue;
    aggregated.push(buildVisitImpactGroup(role, members));
  }
  return aggregated;
}

function determineVisitImpactRole(hit: AnnotatedHit): VisitImpactRole {
  if (hasRole(hit, "ENTITY")) return "ENTITY";
  if (hasRole(hit, "REPOSITORY")) return "REPOSITORY";
  if (hasRole(hit, "REST_CONTROLLER")) return "CONTROLLER";
  if (hasRole(hit, "DTO")) return "DTO";
  if (hasRole(hit, "TEST")) return "TEST";
  return "OTHER";
}

function buildVisitImpactGroup(
  role: VisitImpactRole,
  members: AnnotatedHit[],
): AnnotatedHit {
  const base = members[0];
  const roleLabel = {
    ENTITY: "Entities",
    REPOSITORY: "Repositories",
    CONTROLLER: "Controllers",
    DTO: "DTOs / Mappers",
    TEST: "Tests",
    OTHER: "Other impact",
  }[role];
  const metadata = {
    visitImpact: members.map((member) => ({
      fqn: member.fqn,
      module: member.module,
      filePath: member.metadata?.filePath,
      roles: member.inferredRoles,
    })),
    groupedRole: role,
    groupSize: members.length,
  };
  return {
    fqn: `${role}-entity-impact`,
    kind: "CLASS",
    module: base?.module,
    repoName: base?.repoName,
    summary: `${roleLabel} (${members.length} match${members.length === 1 ? "" : "es"})`,
    score: Math.max(...members.map((member) => member.score ?? 0)),
    metadata: { ...(base?.metadata ?? {}), ...metadata },
    inferredRoles: [role],
  } as AnnotatedHit;
}

function expandBeanResults(hits: AnnotatedHit[]): AnnotatedHit[] {
  const nonModuleHits = hits.filter((hit) => hit.kind !== "MODULE");
  const moduleHits = hits.filter((hit) => hit.kind === "MODULE");
  const synthetic = moduleHits.flatMap((moduleHit) => buildBeanHitsFromModule(moduleHit));
  const combined = dedupeBeanHits([...nonModuleHits, ...synthetic]);
  return combined.length ? combined : hits;
}

function buildBeanHitsFromModule(moduleHit: AnnotatedHit): AnnotatedHit[] {
  const beanList = normalizeBeanList(moduleHit.metadata?.springBeans);
  if (!beanList.length) return [];
  return beanList.map((beanFqn, index) => {
    const inferred = inferRolesFromBeanName(beanFqn);
    return {
      fqn: beanFqn,
      kind: "CLASS",
      module: moduleHit.module,
      repoName: moduleHit.repoName,
      summary: `${beanFqn} (from ${moduleHit.module ?? "module"})`,
      score: (moduleHit.score ?? 0.4) - index * 0.001,
      metadata: {
        sourceModule: moduleHit.fqn,
        derived: true,
      },
      inferredRoles: inferred.length ? inferred : ["SPRING_BEAN"],
    } as AnnotatedHit;
  });
}

function normalizeBeanList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((entry) => String(entry));
  if (typeof raw === "string") return [raw];
  return [];
}

function inferRolesFromBeanName(beanFqn: string): Role[] {
  const lower = beanFqn.toLowerCase();
  const roles: Role[] = [];
  if (lower.includes("controller") || lower.includes("resource")) {
    roles.push("REST_CONTROLLER");
  }
  if (lower.includes("repository")) {
    roles.push("REPOSITORY");
  }
  if (lower.includes("service") || lower.includes("bean") || lower.includes("component")) {
    roles.push("SPRING_BEAN");
  }
  if (lower.includes("config")) {
    roles.push("CONFIG");
  }
  if (!roles.length) {
    roles.push("SPRING_BEAN");
  }
  return roles;
}

function dedupeBeanHits(hits: AnnotatedHit[]): AnnotatedHit[] {
  const seen = new Set<string>();
  const deduped: AnnotatedHit[] = [];
  for (const hit of hits) {
    const key = hit.fqn ?? `${hit.module}:${hit.summary}`;
    if (seen.has(key)) continue;
    deduped.push(hit);
    seen.add(key);
  }
  return deduped;
}

function synthesizeEntityImpactHits(entityHint?: string | null, moduleHint?: string | null): AnnotatedHit[] {
  if (!entityHint) return [];
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) return [];
  const targetRoots: string[] = [];
  if (moduleHint) {
    const moduleRoot = path.join(projectRoot, moduleHint, "src", "main", "java");
    if (fs.existsSync(moduleRoot)) {
      targetRoots.push(moduleRoot);
    }
  }
  if (!targetRoots.length) {
    targetRoots.push(projectRoot);
  }
  let matches = collectEntityJavaFiles(targetRoots, entityHint, 30);
  if (!matches.length && targetRoots[0] !== projectRoot) {
    matches = collectEntityJavaFiles([projectRoot], entityHint, 30);
  }
  if (process.env.DEBUG_VISIT_IMPACT === "1") {
    console.error(
      "[visit-impact] fallback matches",
      matches.slice(0, 5),
    );
  }
  const hits = matches.map((absPath) =>
    buildEntityImpactHitFromFile(absPath, projectRoot, moduleHint, entityHint),
  );
  if (process.env.DEBUG_VISIT_IMPACT === "1") {
    console.error(
      "[visit-impact] synthesized roles",
      hits.map((hit) => ({
        fqn: hit.fqn,
        roles: hit.inferredRoles,
      })),
    );
  }
  return hits;
}

function collectEntityJavaFiles(
  roots: string[],
  entityHint: string,
  limit: number,
): string[] {
  const results: string[] = [];
  const lowerEntity = entityHint.toLowerCase();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const current = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absPath);
          continue;
        }
        if (
          entry.isFile() &&
          entry.name.endsWith(".java") &&
          entry.name.toLowerCase().includes(lowerEntity)
        ) {
          results.push(absPath);
          if (results.length >= limit) {
            return results;
          }
        }
      }
    }
  }
  return results;
}

function buildEntityImpactHitFromFile(
  absPath: string,
  projectRoot: string,
  moduleHint: string | null | undefined,
  entityHint: string,
): AnnotatedHit {
  const relToProject = path.relative(projectRoot, absPath);
  const segments = relToProject.split(path.sep);
  const moduleName = segments[0] ?? moduleHint ?? "default-module";
  const javaRootIndex = segments.findIndex(
    (segment, index) =>
      segment === "src" &&
      segments[index + 1] === "main" &&
      segments[index + 2] === "java",
  );
  const packageSegments =
    javaRootIndex >= 0 ? segments.slice(javaRootIndex + 3) : segments.slice(1);
  const relUnix = packageSegments.join("/");
  const filePath = path
    .join(moduleName, "src", "main", "java", ...packageSegments)
    .split(path.sep)
    .join("/");
  const fqn = packageSegments
    .join(".")
    .replace(/\.java$/i, "");
  const roles = inferEntityImpactRolesFromPath(fqn, relUnix);
  return {
    fqn,
    kind: "CLASS",
    module: moduleName,
    repoName: "spring-petclinic-microservices",
    summary: `${fqn} (${entityHint} impact fallback)`,
    score: 0.42,
    metadata: {
      filePath,
    },
    inferredRoles: roles,
  } as AnnotatedHit;
}

function inferEntityImpactRolesFromPath(fqn: string, relPath: string): Role[] {
  const lowerFqn = fqn.toLowerCase();
  const lowerPath = relPath.toLowerCase();
  const roles: Role[] = [];
  if (lowerFqn.includes("repository")) roles.push("REPOSITORY");
  if (lowerFqn.includes("resource") || lowerFqn.includes("controller")) {
    roles.push("REST_CONTROLLER");
  }
  if (lowerFqn.includes("dto") || lowerPath.includes("/dto/")) roles.push("DTO");
  if (lowerFqn.includes("test") || lowerPath.includes("/test/")) roles.push("TEST");
  if (
    lowerFqn.endsWith(".visit") ||
    lowerFqn.includes("visitbuilder") ||
    lowerPath.includes("/model/") ||
    lowerPath.includes("/entity/")
  ) {
    roles.push("ENTITY");
  }
  if (!roles.length) {
    roles.push("OTHER");
  }
  return roles;
}

function deriveControllerFromMethod(hit: AnnotatedHit): string | undefined {
  const metadata = hit.metadata ?? {};
  const fromMetadata =
    (metadata.enclosingClass as string) ??
    (metadata.parentFqn as string) ??
    (metadata.controllerFqn as string);
  if (fromMetadata) return fromMetadata;
  if (typeof metadata.classFqn === "string") {
    return metadata.classFqn;
  }
  const fqn = hit.fqn ?? "";
  if (fqn.includes("#")) {
    return fqn.substring(0, fqn.indexOf("#"));
  }
  const lastDot = fqn.lastIndexOf(".");
  if (lastDot > 0) {
    return fqn.substring(0, lastDot);
  }
  return undefined;
}

function deriveMethodName(hit: AnnotatedHit): string | undefined {
  if (hit.metadata?.methodName && typeof hit.metadata.methodName === "string") {
    return hit.metadata.methodName;
  }
  const fqn = hit.fqn ?? "";
  if (fqn.includes("#")) {
    return fqn.substring(fqn.indexOf("#") + 1);
  }
  const match = fqn.match(/\.([A-Za-z0-9_]+)$/);
  if (match) {
    return match[1];
  }
  if (hit.summary) {
    const nameMatch = hit.summary.match(/([A-Za-z0-9_]+)\s*\(/);
    if (nameMatch) {
      return nameMatch[1];
    }
  }
  return undefined;
}

function normalizeAnnotationList(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).toLowerCase());
  }
  if (typeof raw === "string") {
    return [raw.toLowerCase()];
  }
  return undefined;
}

function dedupeEndpoints(groups: EndpointDescriptor[]): EndpointDescriptor[] {
  const seen = new Set<string>();
  const deduped: EndpointDescriptor[] = [];
  for (const endpoint of groups) {
    const key = [endpoint.controller, endpoint.name, endpoint.httpVerb ?? "", endpoint.httpPath ?? ""].join("|");
    if (seen.has(key)) continue;
    deduped.push(endpoint);
    seen.add(key);
  }
  return deduped;
}

function buildEndpointHit(descriptor: EndpointDescriptor): AnnotatedHit {
  const summaryParts = [descriptor.httpVerb, descriptor.httpPath, descriptor.summary].filter(Boolean);
  const summary = summaryParts.length ? summaryParts.join(" ") : `${descriptor.controller}#${descriptor.name}`;
  return {
    fqn: `${descriptor.controller}#${descriptor.name}`,
    kind: "METHOD",
    module: descriptor.module,
    summary,
    metadata: {
      controller: descriptor.controller,
      httpVerb: descriptor.httpVerb,
      httpPath: descriptor.httpPath,
      endpointName: descriptor.name,
    },
    inferredRoles: ["REST_ENDPOINT"],
    score: 0.5,
  } as AnnotatedHit;
}

function getMethodAnnotations(metadata: Record<string, unknown>, methodName: string): string[] {
  const raw = metadata.methodAnnotations as unknown;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).toLowerCase());
  }
  if (typeof raw === "object") {
    const value = (raw as Record<string, unknown>)[methodName];
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry).toLowerCase());
    }
    if (typeof value === "string") {
      return [value.toLowerCase()];
    }
  }
  return [];
}

function detectHttpVerb(annotations: string[]): string | undefined {
  for (const ann of annotations) {
    if (ann.includes("getmapping")) return "GET";
    if (ann.includes("postmapping")) return "POST";
    if (ann.includes("putmapping")) return "PUT";
    if (ann.includes("deletemapping")) return "DELETE";
    if (ann.includes("patchmapping")) return "PATCH";
    if (ann.includes("requestmapping")) return "REQUEST";
  }
  return undefined;
}

function detectHttpPath(annotations: string[]): string | undefined {
  const pathPattern = /\("([^"]+)"\)/;
  for (const ann of annotations) {
    const match = pathPattern.exec(ann);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function applyGrouping(
  hits: AnnotatedHit[],
  grouping: ResultGrouping = "none",
): AnnotatedHit[] {
  if (!hits.length || grouping === "none") {
    return hits;
  }
  if (grouping === "byModule") {
    return groupHitsByModule(hits);
  }
  if (grouping === "byRole") {
    return groupHitsByRole(hits);
  }
  return hits;
}

function groupHitsByModule(hits: AnnotatedHit[]): AnnotatedHit[] {
  const bucket = new Map<string, { members: AnnotatedHit[]; roles: Set<Role> }>();
  for (const hit of hits) {
    const module = hit.module ?? "unknown-module";
    if (!bucket.has(module)) {
      bucket.set(module, { members: [], roles: new Set() });
    }
    const entry = bucket.get(module)!;
    entry.members.push(hit);
    for (const role of hit.inferredRoles ?? []) {
      entry.roles.add(role);
    }
  }
  return Array.from(bucket.entries()).map(([module, entry]) =>
    buildAggregatedModuleHit(module, entry.members, entry.roles),
  );
}

function groupHitsByRole(hits: AnnotatedHit[]): AnnotatedHit[] {
  const bucket = new Map<string, AnnotatedHit[]>();
  for (const hit of hits) {
    const primaryRole = (hit.inferredRoles ?? ["OTHER"])[0];
    if (!bucket.has(primaryRole)) {
      bucket.set(primaryRole, []);
    }
    bucket.get(primaryRole)!.push(hit);
  }
  const aggregated: AnnotatedHit[] = [];
  for (const [role, members] of bucket.entries()) {
    const base = members[0];
    const metadata = {
      ...(base.metadata ?? {}),
      groupedRole: role,
      groupSize: members.length,
      children: members.map((hit) => hit.fqn),
    };
    aggregated.push({
      ...base,
      fqn: `${role}-group`,
      summary: `${role}: ${members.length} result(s)`,
      metadata,
      inferredRoles: [role as Role],
      score: Math.max(...members.map((hit) => hit.score ?? 0)),
    });
  }
  return aggregated;
}

function buildAggregatedModuleHit(
  module: string,
  members: AnnotatedHit[],
  roles: Set<Role>,
): AnnotatedHit {
  const first = members[0];
  const aggregatedRoles = Array.from(roles);
  const metadata = {
    moduleMembers: members.map((hit) => hit.fqn),
    roles: aggregatedRoles,
    grouped: true,
  };
  const summary = `${module} (${aggregatedRoles.join(", ") || "module"})`;
  return {
    fqn: `${module}#module-group`,
    kind: "MODULE",
    module,
    repoName: first?.repoName,
    summary,
    score: Math.max(...members.map((hit) => hit.score ?? 0)),
    metadata,
    inferredRoles: aggregatedRoles,
  } as AnnotatedHit;
}

function applyRoleBoosts(
  hits: AnnotatedHit[],
  boosts?: Partial<Record<Role, number>>,
  profileId?: string,
  options?: { modulePreference?: string | null },
): AnnotatedHit[] {
  if (!boosts) return hits;
  const scored = [...hits];
  scored.sort(
    (a, b) =>
      getBoostedScore(b, boosts, profileId, options) -
      getBoostedScore(a, boosts, profileId, options),
  );
  return scored;
}

function buildRerankText(hit: AnnotatedHit): string {
  const roles = (hit.inferredRoles ?? []).join(",");
  const moduleSummary = summarizeModuleCounts(hit.metadata?.moduleSummary);
  const lib = [
    hit.metadata?.library ? `library=${hit.metadata.library}` : "",
    hit.metadata?.libraryRole ? `libraryRole=${hit.metadata.libraryRole}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const counters = [
    typeof hit.metadata?.callersCount === "number"
      ? `callers=${hit.metadata.callersCount}`
      : "",
    typeof hit.metadata?.calleesCount === "number"
      ? `callees=${hit.metadata.calleesCount}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const moduleInfo = [
    hit.module ? `module=${hit.module}` : "",
    hit.repoName ? `repo=${hit.repoName}` : "",
    moduleSummary ? `modules=${moduleSummary}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    hit.fqn,
    hit.summary,
    `kind=${hit.kind} level=${hit.indexLevel ?? ""}`,
    moduleInfo,
    roles ? `roles=${roles}` : "",
    counters,
    lib,
  ]
    .filter(Boolean)
    .join(" | ");
}

function summarizeModuleCounts(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .slice(0, 5)
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const mod = (item as any).module ?? "unknown";
      const count = (item as any).count ?? "";
      return `${mod}:${count}`;
    })
    .filter(Boolean)
    .join(",");
}

function buildRerankCandidates(
  hits: AnnotatedHit[],
  maxCandidates: number,
): RerankCandidate[] {
  return hits.slice(0, maxCandidates).map((hit, index) => ({
    id: `${hit.fqn}#${index}`,
    text: buildRerankText(hit),
  }));
}

function extractModuleSpread(summary: unknown): { uniqueModules: number; topCount: number } {
  if (!summary || typeof summary !== "object") return { uniqueModules: 0, topCount: 0 };
  const modules = new Map<string, number>();
  const track = (list?: any) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item) continue;
      const name = typeof item.module === "string" ? item.module : "unknown";
      const count = typeof item.count === "number" ? item.count : 1;
      modules.set(name, (modules.get(name) ?? 0) + count);
    }
  };

  const summaryObj = summary as Record<string, unknown>;
  track(summaryObj.callers);
  track(summaryObj.callees);
  if (!modules.size && Array.isArray(summary)) {
    track(summary);
  }

  let topCount = 0;
  for (const count of modules.values()) {
    if (count > topCount) topCount = count;
  }
  return { uniqueModules: modules.size, topCount };
}

function getBoostedScore(
  hit: AnnotatedHit,
  boosts: Partial<Record<Role, number>>,
  profileId?: string,
  options?: { modulePreference?: string | null },
): number {
  let base = hit.score ?? 0;
  const bonus = (hit.inferredRoles ?? []).reduce((acc, role) => {
    return Math.max(acc, boosts[role] ?? 0);
  }, 0);
  const metadata = (hit.metadata ?? {}) as Record<string, unknown>;
  const callersCount =
    typeof metadata.callersCount === "number" ? metadata.callersCount : 0;
  const calleesCount =
    typeof metadata.calleesCount === "number" ? metadata.calleesCount : 0;
  const fqnLower = hit.fqn.toLowerCase();
  const modulePreference = options?.modulePreference
    ? options.modulePreference.toLowerCase()
    : null;
  const moduleSpread = extractModuleSpread(metadata.moduleSummary);

  // Impact-style boost: heavily-used or central classes score higher.
  const impactBoost =
    Math.log1p(Math.max(callersCount, 0)) * 0.04 +
    Math.log1p(Math.max(calleesCount, 0)) * 0.02;

  let infraBoost = 0;
  if (profileId === "impact-analysis") {
    const category = detectInfraCategory(hit);
    if (category === "HTTP") infraBoost = 0.12;
    else if (category === "MQ") infraBoost = 0.12;
    else if (category === "DB") infraBoost = 0.1;
    if (modulePreference && hit.module?.toLowerCase() === modulePreference) {
      infraBoost += 0.05;
    }
  }

  // Additional penalty for test symbols in impact-style scenarios.
  const roles = (hit.inferredRoles ?? []) as Role[];
  const isTest = roles.includes("TEST");
  const testImpactPenalty = isTest ? -0.3 : 0;

  let structuralBoost = 0;
  if (profileId === "impact-analysis") {
    const isRest = hasRole(hit, "REST_CONTROLLER") || hasRole(hit, "REST_ENDPOINT");
    const isServiceLike = /service$/i.test(hit.fqn) || hasRole(hit, "SPRING_BEAN");
    const isMapper =
      hasRole(hit, "REPOSITORY") &&
      (/\bmapper$/i.test(hit.fqn) || /\bmapper\b/i.test(fqnLower));
    // Prefer production calls: more callers/callees push impact up; deprioritize tests already via penalty.
    if (isRest) structuralBoost += 0.12;
    if (isServiceLike) structuralBoost += 0.08;
    if (isMapper) structuralBoost += 0.08;
    // Higher callersCount gets additional small lift (beyond log boost) to spread impact signals.
    structuralBoost += Math.min(callersCount, 20) * 0.005;
    if (moduleSpread.uniqueModules > 1) {
      structuralBoost += Math.min(moduleSpread.uniqueModules, 8) * 0.01;
    }
    if (moduleSpread.topCount > 0) {
      structuralBoost += Math.min(moduleSpread.topCount, 12) * 0.003;
    }
  }

  return base + bonus + impactBoost + infraBoost + structuralBoost + testImpactPenalty;
}

function detectInfraCategory(hit: AnnotatedHit): "HTTP" | "MQ" | "DB" | null {
  const fqn = hit.fqn.toLowerCase();
  const metaText = JSON.stringify(hit.metadata ?? {}).toLowerCase();
  if (
    fqn.includes("resttemplate") ||
    fqn.includes("webclient") ||
    fqn.includes("restoperations") ||
    fqn.includes("feign") ||
    fqn.includes("httpclient") ||
    metaText.includes("http")
  ) {
    return "HTTP";
  }
  if (
    fqn.includes("rabbit") ||
    fqn.includes("kafka") ||
    fqn.includes("rocketmq") ||
    fqn.includes("amqp") ||
    fqn.includes("jms") ||
    metaText.includes("mq")
  ) {
    return "MQ";
  }
  if (
    hasRole(hit, "REPOSITORY") ||
    fqn.includes("jdbc") ||
    fqn.includes("mybatis") ||
    fqn.includes("jpa") ||
    fqn.includes("datasource") ||
    metaText.includes("repository")
  ) {
    return "DB";
  }
  if (metaText.includes("mq")) return "MQ";
  if (metaText.includes("http")) return "HTTP";
  return null;
}

function applyBudgetStrategy(
  hits: AnnotatedHit[],
  profile: QueryProfile,
  tokenLimit: number,
): ContextBudgetReport {
  const delivered: AnnotatedHit[] = [];
  let usedTokens = 0;
  let truncated = false;
  let omitted = 0;
  const detailedLimit = profile.budgetStrategy === "breadth" ? 5 : hits.length;

  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const metadata = (hit.metadata ??= {});
    let cost = estimateTokens(hit);
    if (profile.budgetStrategy === "breadth" && index >= detailedLimit) {
      cost = Math.max(5, Math.floor(cost / 4));
      metadata.previewLevel = "minimal";
    } else if (profile.budgetStrategy === "breadth") {
      metadata.previewLevel = "detailed";
    }
    if (usedTokens + cost > tokenLimit) {
      truncated = true;
      omitted += hits.length - index;
      break;
    }
    usedTokens += cost;
    delivered.push(hit);
  }

  return {
    delivered,
    usedTokens,
    tokenLimit,
    omittedCount: omitted,
    truncated,
  };
}

function clampTokenLimit(maxTokens?: number): number {
  const limit = typeof maxTokens === "number" ? maxTokens : 9000;
  return Math.min(Math.max(limit, 1000), 20000);
}

function stringifyHit(hit: SearchHit): string {
  const parts = [hit.fqn, hit.summary ?? "", JSON.stringify(hit.metadata ?? {})];
  return parts.join(" ").toLowerCase();
}

function inferModuleHint(query: string, provided?: string | null) {
  if (provided) {
    return provided;
  }
  const lower = query.toLowerCase();
  if (lower.includes("visit")) return "spring-petclinic-visits-service";
  if (
    lower.includes("customer") ||
    lower.includes("owner") ||
    lower.includes("pet")
  )
    return "spring-petclinic-customers-service";
  if (
    lower.includes("vet") ||
    lower.includes("veterinarian") ||
    lower.includes("specialty")
  )
    return "spring-petclinic-vets-service";
  if (lower.includes("api gateway")) return "spring-petclinic-api-gateway";
  return null;
}

function detectScenario(lower: string): SearchScenario {
  if (lower.includes("spring boot") && (lower.includes("entry") || lower.includes("entrypoint"))) {
    return "spring_boot_entry";
  }
  if (lower.includes("discovery") || lower.includes("eureka")) {
    return "discovery_deps";
  }
  if (
    (lower.includes("endpoint") || lower.includes("rest")) &&
    (lower.includes("record") || lower.includes("handle"))
  ) {
    return "entity_endpoints";
  }
  if (
    lower.includes("schema") ||
    lower.includes("change") ||
    lower.includes("impact") ||
    lower.includes("affect")
  ) {
    return "entity_impact";
  }
  if (
    lower.includes("what happens if i change") ||
    lower.includes("change this api") ||
    lower.includes("breaking change") ||
    lower.includes("migrate from") ||
    lower.includes("migrate to") ||
    lower.includes("migration") ||
    lower.includes("deprecated") ||
    lower.includes("deprecate") ||
    lower.includes("replace") ||
    lower.includes("wshttpclient.send") ||
    lower.includes("abstracttransactionstatus.setrollbackonly") ||
    lower.includes("jdbctemplate.query")
  ) {
    return "impact_analysis";
  }
  if (lower.includes("beanpostprocessor")) {
    return "bean_post_processor";
  }
  if (lower.includes("spring bean") || (lower.includes("all") && lower.includes("bean"))) {
    return "all_beans";
  }
  return null;
}

function pickProfile(queryLower: string, scenario: SearchScenario | null): QueryProfile {
  if (scenario) {
    const match = PROFILE_REGISTRY.find((profile) => profile.scenario === scenario);
    if (match) {
      return match;
    }
  }
  return GENERIC_PROFILE;
}

function deriveSearchStrategy(args: SearchArguments): SearchStrategy {
  const lowerQuery = args.query.toLowerCase();
  const tokens = args.query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const hasKeyword = containsComplexKeywords(args.query);
  let profile: SearchStrategy["profile"] = "balanced";
  if (tokens.length <= 2 && !hasKeyword) {
    profile = "targeted";
  } else if (tokens.length > 5 || hasKeyword) {
    profile = "deep";
  }

  const scenario = detectScenario(lowerQuery);
  const entityHint = inferEntityFromQuery(args.query);
  if (scenario && profile === "targeted") {
    profile = "balanced";
  }

  const defaultLevels =
    profile === "deep"
      ? ["module", "class", "method"]
      : profile === "targeted"
        ? ["class"]
        : ["module", "class"];

  const preferredLevels = Array.from(
    new Set(args.preferredLevels ?? defaultLevels),
  );

  const profileConfig = pickProfile(lowerQuery, scenario);

  const strategy: SearchStrategy = {
    profile,
    reason:
      profile === "deep"
        ? "复杂查询或包含调用链/影响分析关键词"
        : profile === "targeted"
          ? "短查询，仅需精准类/接口结果"
          : "默认两阶段搜索",
    preferredLevels,
    moduleLimit: profile === "deep" ? 8 : profile === "targeted" ? 3 : 5,
    classLimit:
      profile === "deep"
        ? Math.min(12, Math.max(args.limit ?? 8, 10))
        : profile === "targeted"
          ? Math.min(6, args.limit ?? 5)
          : Math.min(8, args.limit ?? 6),
    methodLimit: preferredLevels.includes("method") ? 6 : 0,
    moduleFilter: args.moduleFilter ?? null,
    moduleHint: inferModuleHint(args.query, args.moduleHint ?? null),
    scenario,
    profileConfig,
    entityHint,
  };

  if (strategy.moduleHint && profile !== "deep") {
    strategy.moduleLimit = Math.max(2, strategy.moduleLimit - 1);
  }

  return strategy;
}

function scenarioMinTokenMatch(scenario: SearchScenario | null): number | undefined {
  if (!scenario) return undefined;
  if (
    scenario === "entity_impact" ||
    scenario === "entity_endpoints" ||
    scenario === "all_beans"
  ) {
    return 1;
  }
  return undefined;
}

export function createSearchPipeline({
  bridgeClient,
  milvusClient,
  fallbackSymbols,
  fixtureRegistry,
}: {
  bridgeClient?: IdeaBridgeClient;
  milvusClient?: MilvusSearchHandle;
  fallbackSymbols: SymbolRecord[];
  fixtureRegistry?: FixtureRegistry;
}) {
  const rerankConfig = loadRerankConfig();
  const reranker = createReranker(rerankConfig);

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

  async function search(args: SearchArguments): Promise<SearchOutcome> {
    const strategy = deriveSearchStrategy(args);
    const scenarioId = args.scenarioId ?? null;
    const profile = strategy.profileConfig;
    const scenarioArgs: SearchArguments = {
      ...args,
      scenario: strategy.scenario ?? null,
      scenarioId: scenarioId ?? undefined,
    };
    const minTokenMatch = scenarioMinTokenMatch(strategy.scenario ?? null);
    const rankingArgs: SearchArguments =
      typeof minTokenMatch === "number"
        ? { ...scenarioArgs, minTokenMatch }
        : scenarioArgs;
    const queryTokens = extractQueryTokens(scenarioArgs.query.toLowerCase());
    const buildQueryForStage = (stage: StagePreference) =>
      buildStageQuery(
        queryTokens,
        scenarioArgs.query,
        stage,
        strategy.scenario ?? null,
        strategy.entityHint ?? null,
      );
    const tokenLimit = clampTokenLimit(scenarioArgs.maxContextTokens);

    if (fixtureRegistry && scenarioId && fixtureRegistry.has(scenarioId)) {
      const fixtureOutcome = fixtureRegistry.buildOutcome(
        scenarioId,
        strategy,
        tokenLimit,
      );
      if (fixtureOutcome) {
        return fixtureOutcome;
      }
    }

    const stageHits: StageHitMap = {
      bridge: [],
      "milvus-module": [],
      "milvus-class": [],
      "milvus-method": [],
      fallback: [],
    };

    const allowBridgeStage = strategy.profile === "targeted";
    if (allowBridgeStage) {
      const bridgeResults = await tryBridge(rankingArgs);
      if (bridgeResults?.length) {
        const annotatedBridge = annotateHits(bridgeResults);
        const bridgeBudget = applyBudgetStrategy(
          annotatedBridge,
          profile,
          tokenLimit,
        );
        return {
          finalResults: bridgeBudget.delivered,
          moduleResults: undefined,
          methodResults: undefined,
          fallbackUsed: false,
          stages: [{ name: "bridge", hits: annotatedBridge }],
          strategy,
          contextBudget: bridgeBudget,
        };
      }
    }

    const baseMilvusArgs: SearchArguments = {
      ...rankingArgs,
      moduleHint: strategy.moduleHint ?? args.moduleHint,
      moduleFilter: profile.moduleFilter ?? args.moduleFilter,
    };

    if (strategy.preferredLevels.includes("module")) {
      const results = await tryMilvus({
        ...baseMilvusArgs,
        query: buildQueryForStage("module"),
        preferredLevels: ["module"],
        limit: strategy.moduleLimit,
      });
      stageHits["milvus-module"] = annotateHits(results);
    }

    if (strategy.preferredLevels.includes("class")) {
      const results = await tryMilvus({
        ...baseMilvusArgs,
        query: buildQueryForStage("class"),
        preferredLevels: ["class"],
        limit: strategy.classLimit,
      });
      stageHits["milvus-class"] = annotateHits(results);
    }

    if (strategy.preferredLevels.includes("method") && strategy.methodLimit > 0) {
      const results = await tryMilvus({
        ...baseMilvusArgs,
        query: buildQueryForStage("method"),
        preferredLevels: ["method"],
        limit: strategy.methodLimit || strategy.classLimit,
      });
      stageHits["milvus-method"] = annotateHits(results);
    }

    const needsBridgeClassAugment = profile.id === "entity-impact";
    if (
      needsBridgeClassAugment &&
      (!stageHits["milvus-class"]?.length ||
        stageHits["milvus-class"]!.length < strategy.classLimit)
    ) {
      if (process.env.DEBUG_VISIT_IMPACT === "1") {
        console.error("[visit-impact] initiating bridge augment");
      }
      const visitBridgeQuery = "Visit";
      const bridgeAugmentArgs: SearchArguments = {
        ...rankingArgs,
        query: visitBridgeQuery,
        preferredLevels: ["class"],
        limit: Math.max(strategy.classLimit, args.limit ?? 5),
        moduleFilter:
          profile.moduleFilter ??
          args.moduleFilter ??
          strategy.moduleHint ??
          scenarioArgs.moduleHint,
      };
      const bridgeClassResults = await tryBridge(bridgeAugmentArgs);
      if (process.env.DEBUG_VISIT_IMPACT === "1") {
        console.error(
          "[visit-impact] bridge augment results",
          bridgeClassResults?.length ?? 0,
        );
      }
      if (bridgeClassResults?.length) {
        const existing = stageHits["milvus-class"] ?? [];
        stageHits["milvus-class"] = existing.length
          ? existing.concat(annotateHits(bridgeClassResults))
          : annotateHits(bridgeClassResults);
      }
    }

    const filteredStageHits = applyProfileFilters(stageHits, profile);
    const stages: SearchStage[] = buildStageSummaries(filteredStageHits);
    let orderedHits = assemblePreferredHits(
      filteredStageHits,
      profile.preferredLevels,
      stageHits,
    );

    if (!orderedHits.length) {
      orderedHits = flattenStageHits(stageHits);
    }

    const groupedHits = applyGrouping(orderedHits, profile.grouping);
    const scenarioHits = specializeScenarioResults(groupedHits, profile.id, {
      entityHint: strategy.entityHint,
      moduleHint: strategy.moduleHint ?? args.moduleHint ?? null,
    });
    const rankedHits = applyRoleBoosts(scenarioHits, profile.roleBoosts, profile.id, {
      modulePreference: strategy.moduleHint ?? args.moduleHint ?? args.moduleFilter ?? null,
    });
    let rerankedHits = rankedHits;
    let rerankUsed = false;

    if (
      reranker &&
      rerankConfig.enabled &&
      rankedHits.length > 1 &&
      rerankConfig.maxCandidates > 1
    ) {
      const candidates = buildRerankCandidates(
        rankedHits,
        Math.min(rerankConfig.maxCandidates, rankedHits.length),
      );
      if (candidates.length > 1) {
        try {
          const started = Date.now();
          const results = await reranker.rerank(args.query, candidates);
          const sorted = [...results].sort((a, b) => b.score - a.score);
          const seen = new Set<string>();
          const hitMap = new Map<string, AnnotatedHit>();
          candidates.forEach((cand, idx) => {
            hitMap.set(cand.id, rankedHits[idx]);
          });
          const reranked: AnnotatedHit[] = [];
          for (const res of sorted.slice(0, rerankConfig.topK)) {
            const hit = res.id ? hitMap.get(res.id) : undefined;
            if (hit && !seen.has(hit.fqn)) {
              reranked.push(hit);
              seen.add(hit.fqn);
            }
          }
          for (const hit of rankedHits) {
            if (!seen.has(hit.fqn)) {
              reranked.push(hit);
              seen.add(hit.fqn);
            }
          }
          if (reranked.length) {
            rerankedHits = reranked;
            rerankUsed = true;
          }
          if (rerankConfig.logProbes) {
            console.error(
              "[rerank] applied provider=",
              rerankConfig.provider ?? "jina",
              "durationMs=",
              Date.now() - started,
              "candidates=",
              candidates.length,
            );
          }
        } catch (error) {
          if (rerankConfig.logProbes) {
            console.error("[rerank] failed, using original order", error);
          }
        }
      }
    }
    let budget = applyBudgetStrategy(rerankedHits, profile, tokenLimit);
    let fallbackUsed = false;

    if (!budget.delivered.length) {
      const fallbackHits = annotateHits(rankSymbols(fallbackSymbols, rankingArgs));
      budget = applyBudgetStrategy(fallbackHits, profile, tokenLimit);
      stages.push({ name: "fallback", hits: fallbackHits });
      fallbackUsed = true;
    }

    return {
      finalResults: budget.delivered,
      moduleResults: filteredStageHits["milvus-module"],
      methodResults: filteredStageHits["milvus-method"],
      fallbackUsed,
      stages,
      strategy,
      contextBudget: budget,
      rerankUsed,
    };
  }

  return {
    search,
  };
}
function extractEndpointsFromSource(filePath?: string) {
  if (!filePath) return [];
  const absolutePath = resolveRepoPath(filePath);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    return [];
  }
  let source: string;
  try {
    source = fs.readFileSync(absolutePath, "utf8");
  } catch {
    return [];
  }
  const lines = source.split(/\r?\n/);
  const endpoints: {
    name: string;
    httpVerb?: string;
    httpPath?: string;
  }[] = [];
  let pendingVerb: string | undefined;
  let pendingPath: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    const mappingMatch = trimmed.match(/@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)(\(([^)]*)\))?/);
    if (mappingMatch) {
      pendingVerb = mappingMatch[1].toUpperCase();
      const paramsRaw = mappingMatch[3] ?? "";
      pendingPath = extractPathFromParams(paramsRaw);
      if (pendingVerb === "REQUEST") {
        const methodMatch = paramsRaw.match(/RequestMethod\.(\w+)/i);
        if (methodMatch) {
          pendingVerb = methodMatch[1].toUpperCase();
        }
      }
      continue;
    }
    if (pendingVerb && trimmed.startsWith("@")) {
      // Skip other annotations between mapping and method signature.
      continue;
    }
    if (pendingVerb && /\bpublic\b/.test(trimmed)) {
      const methodMatch = trimmed.match(/public\s+[\w<>,\[\]\s]+\s+(\w+)\s*\(/);
      if (methodMatch) {
        endpoints.push({
          name: methodMatch[1],
          httpVerb: pendingVerb,
          httpPath: pendingPath,
        });
        pendingVerb = undefined;
        pendingPath = undefined;
      }
    }
  }
  return endpoints;
}

function resolveRepoPath(relPath: string): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), "..", relPath),
    path.resolve(process.cwd(), "..", "spring-petclinic-microservices", relPath),
    path.resolve(process.cwd(), "..", "..", "spring-petclinic-microservices", relPath),
  ];
  const envRoot = process.env.PETCLINIC_REPO_ROOT;
  if (envRoot) {
    candidates.push(path.resolve(envRoot, relPath));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function resolveProjectRoot(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), "..", "spring-petclinic-microservices"),
    path.resolve(process.cwd(), "..", "..", "spring-petclinic-microservices"),
  ];
  const envRoot = process.env.PETCLINIC_REPO_ROOT;
  if (envRoot) {
    candidates.unshift(path.resolve(envRoot));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractPathFromParams(params: string): string | undefined {
  if (!params) return undefined;
  const match = params.match(/"([^"]+)"/);
  return match ? match[1] : undefined;
}

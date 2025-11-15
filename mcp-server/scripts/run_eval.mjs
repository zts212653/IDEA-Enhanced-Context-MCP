#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(projectRoot, "..");

const FIXED_SCENARIOS = [
  {
    id: "q1-entrypoints",
    type: "ENTRYPOINTS",
    query: "Show me all Spring Boot service entry points across microservices",
    preferredLevels: ["module", "class"],
  },
  {
    id: "q2-discovery",
    type: "DISCOVERY_DEPS",
    query: "Which services depend on the discovery server?",
    preferredLevels: ["module", "class"],
  },
  {
    id: "q3-visit-endpoints",
    type: "REST_ENDPOINTS",
    entity: "Visit",
    moduleHint: "spring-petclinic-visits-service",
    query: "Find all REST endpoints that handle pet visit records",
    preferredLevels: ["module", "class", "method"],
  },
  {
    id: "q4-visit-impact",
    type: "ENTITY_IMPACT",
    entity: "Visit",
    moduleHint: "spring-petclinic-visits-service",
    query: "If I change the Visit entity schema, what controllers, repositories, and DTOs will be affected?",
    preferredLevels: ["module", "class", "method"],
  },
  {
    id: "q5-beans",
    type: "ALL_BEANS",
    query: "Show me all Spring beans in the entire project",
    preferredLevels: ["module", "class"],
    maxContextTokens: 4000,
  },
];

function parseArgs() {
  const args = {};
  for (const token of process.argv.slice(2)) {
    if (!token.startsWith("--")) continue;
    const [key, value] = token.split("=");
    args[key.slice(2)] = value ?? "true";
  }
  return args;
}

function parseListArg(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function parseBooleanFlag(value) {
  if (value == null) return false;
  const normalized = String(value).toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

async function loadFixtureScenarioSet() {
  const fixturePath = path.resolve(__dirname, "..", "fixtures", "petclinic-fixtures.json");
  try {
    const raw = await fs.readFile(fixturePath, "utf8");
    const json = JSON.parse(raw);
    return new Set(Object.keys(json));
  } catch {
    return null;
  }
}

async function loadScenarioFile(filePath) {
  const absolute = path.resolve(filePath);
  const json = JSON.parse(await fs.readFile(absolute, "utf8"));
  if (!Array.isArray(json)) {
    throw new Error(`Scenario file ${filePath} must be an array`);
  }
  return json;
}

function getRoleList(hit) {
  const roles = new Set();
  const fromField = Array.isArray(hit.roles) ? hit.roles : [];
  const fromMetadata = Array.isArray(hit.metadata?.roles)
    ? hit.metadata.roles
    : [];
  for (const role of [...fromField, ...fromMetadata]) {
    if (typeof role === "string") roles.add(role);
  }
  return roles;
}

function textContains(value, needle) {
  if (!needle) return false;
  const lowerNeedle = needle.toLowerCase();
  return String(value ?? "").toLowerCase().includes(lowerNeedle);
}

function hitContainsEntity(hit, entity) {
  if (!entity) return false;
  const lowerEntity = entity.toLowerCase();
  if (textContains(hit.fqn, entity) || textContains(hit.summary, entity)) {
    return true;
  }
  const metadata = hit.metadata ?? {};
  if (metadata.endpoints) {
    const serialized = JSON.stringify(metadata.endpoints).toLowerCase();
    if (serialized.includes(lowerEntity)) return true;
  }
  if (metadata.visitImpact) {
    const serialized = JSON.stringify(metadata.visitImpact).toLowerCase();
    if (serialized.includes(lowerEntity)) return true;
  }
  return false;
}

function checkEntryPoints(response) {
  const hits = response.deliveredResults ?? response.finalResults ?? [];
  const entryCount = hits.filter((hit) => getRoleList(hit).has("ENTRYPOINT"))
    .length;
  return {
    pass: entryCount >= 4,
    reason: entryCount >= 4 ? "entrypoints detected" : "missing ENTRYPOINT roles",
  };
}

function checkDiscoveryDeps(response) {
  const hits = response.deliveredResults ?? response.finalResults ?? [];
  const roles = hits.map((hit) => getRoleList(hit));
  const hasServer = roles.some((set) => set.has("DISCOVERY_SERVER"));
  const hasClient = roles.some((set) => set.has("DISCOVERY_CLIENT"));
  const pass = hasServer && hasClient;
  return {
    pass,
    reason: pass
      ? "found DISCOVERY_SERVER and DISCOVERY_CLIENT"
      : "discovery roles missing",
  };
}

function checkRestEndpoints(response, scenario) {
  const hits = response.deliveredResults ?? response.finalResults ?? [];
  const entity = scenario.entity;
  const hasModule =
    scenario.moduleHint == null
      ? true
      : hits.some(
          (hit) =>
            hit.module === scenario.moduleHint ||
            (hit.module ?? "").includes(scenario.moduleHint),
        );
  const hasRestRole = hits.some((hit) => {
    const roles = getRoleList(hit);
    return roles.has("REST_CONTROLLER") || roles.has("REST_ENDPOINT");
  });
  const entityMatch = hits.some((hit) => hitContainsEntity(hit, entity));
  const pass = hasModule && hasRestRole && entityMatch;
  return {
    pass,
    reason: pass ? "REST endpoints located" : "missing module/entity REST hits",
  };
}

function checkEntityImpact(response, scenario) {
  const hits = response.deliveredResults ?? response.finalResults ?? [];
  const impactHits = hits.filter((hit) => Array.isArray(hit.metadata?.visitImpact));
  const groupedRoles = impactHits.map((hit) => hit.metadata.groupedRole ?? "");
  const entityMatched = impactHits.some((hit) =>
    hitContainsEntity(hit, scenario.entity),
  );
  const pass = impactHits.length > 0 && entityMatched;
  return {
    pass,
    reason: pass
      ? `impact groups: ${groupedRoles.join(", ")}`
      : "no grouped visitImpact metadata",
  };
}

function checkBeans(response) {
  const hits = response.deliveredResults ?? response.finalResults ?? [];
  const usedTokens = response.contextBudget?.usedTokens ?? 0;
  const pass =
    hits.length >= 15 &&
    usedTokens >= 300 &&
    hits.some((hit) => getRoleList(hit).size > 0);
  return {
    pass,
    reason: `beans=${hits.length}, tokens=${usedTokens}`,
  };
}

function evaluateScenario(scenario, response) {
  switch (scenario.type) {
    case "ENTRYPOINTS":
      return checkEntryPoints(response);
    case "DISCOVERY_DEPS":
      return checkDiscoveryDeps(response);
    case "REST_ENDPOINTS":
      return checkRestEndpoints(response, scenario);
    case "ENTITY_IMPACT":
      return checkEntityImpact(response, scenario);
    case "ALL_BEANS":
      return checkBeans(response);
    default:
      return { pass: true, reason: "no checks registered" };
  }
}

async function callSearch(query, options = {}) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: projectRoot,
    env: {
      ...process.env,
    },
    stderr: "inherit",
  });
  const client = new Client({
    name: "idea-enhanced-context-eval",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools({});
    client.cacheToolOutputSchemas(tools.tools ?? []);
    const result = await client.callTool({
      name: "search_java_symbol",
      arguments: {
        query,
        moduleHint: options.moduleHint,
        preferredLevels: options.preferredLevels,
        maxContextTokens: options.maxContextTokens,
        scenarioId: options.scenarioId,
      },
    });
    if (result.isError) {
      throw new Error(result.error.message ?? "tool error");
    }
    return result.structuredContent ?? result.content;
  } finally {
    await client.close();
    if (typeof transport.close === "function") {
      await transport.close();
    }
  }
}

async function main() {
  const args = parseArgs();
  const moduleFilter = parseListArg(args.moduleFilter);
  const typeFilter = parseListArg(args.typeFilter).map((entry) => entry.toUpperCase());
  const entityRegex = args.entityRegex ? new RegExp(args.entityRegex, "i") : null;
  const fixtureEnv = process.env.CI_FIXTURE === "1" || process.env.MCP_EVAL_FIXTURE === "1";
  const fixtureOnly = parseBooleanFlag(args.fixtureOnly) || (fixtureEnv && !args.fixtureOnly);
  const fixtureScenarioSet = fixtureOnly || fixtureEnv ? await loadFixtureScenarioSet() : null;
  if (fixtureOnly && !fixtureScenarioSet) {
    console.error("[run-eval] fixtureOnly is enabled but no fixture file was found");
    process.exit(1);
  }
  const scenarioFiles = args.scenarios
    ? args.scenarios.split(",").map((p) => p.trim()).filter(Boolean)
    : [];
  const dynamicScenarios = [];
  for (const file of scenarioFiles) {
    const scenarios = await loadScenarioFile(file);
    dynamicScenarios.push(...scenarios);
  }
  const allScenarios = [...FIXED_SCENARIOS, ...dynamicScenarios];
  if (allScenarios.length === 0) {
    console.error("[run-eval] no scenarios specified");
    process.exit(1);
  }
  const filteredScenarios = allScenarios.filter((scenario) =>
    scenarioMatchesFilters(scenario, { moduleFilter, typeFilter, entityRegex }),
  );
  if (!filteredScenarios.length) {
    console.error("[run-eval] no scenarios left after applying filters");
    process.exit(1);
  }
  if (moduleFilter.length || typeFilter.length || entityRegex) {
    console.log(
      `[run-eval] applying filters: modules=${moduleFilter.join(",") || "*"}, types=${
        typeFilter.join(",") || "*"
      }, entityRegex=${entityRegex ? entityRegex.source : "*"}`,
    );
  }
  const results = [];
  for (const scenario of filteredScenarios) {
    if (fixtureOnly && fixtureScenarioSet && !fixtureScenarioSet.has(scenario.id)) {
      console.log(`\n[run-eval] running ${scenario.id} (${scenario.type})`);
      console.log(`[run-eval] ${scenario.id}: ↷ skipped (no fixture)`);
      results.push({
        id: scenario.id,
        type: scenario.type,
        pass: true,
        reason: "skipped (no fixture)",
        skipped: true,
        metrics: { delivered: 0, usedTokens: 0 },
      });
      continue;
    }
    console.log(`\n[run-eval] running ${scenario.id} (${scenario.type})`);
    try {
      const payload = await callSearch(scenario.query, {
        ...scenario,
        scenarioId: scenario.id,
      });
      const verdict = evaluateScenario(scenario, payload);
      results.push({
        id: scenario.id,
        type: scenario.type,
        pass: verdict.pass,
        reason: verdict.reason,
        metrics: {
          delivered: payload.deliveredResults?.length ?? payload.finalResults?.length ?? 0,
          usedTokens: payload.contextBudget?.usedTokens ?? null,
        },
      });
      console.log(
        `[run-eval] ${scenario.id}: ${verdict.pass ? "✅" : "❌"} ${verdict.reason}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        type: scenario.type,
        pass: false,
        reason,
      });
      console.error(`[run-eval] ${scenario.id} failed:`, reason);
    }
  }

  await fs.mkdir(path.resolve(repoRoot, "tmp"), { recursive: true });
  const reportPath = path.resolve(repoRoot, "tmp", "eval-report.json");
  await fs.writeFile(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n[run-eval] report written to ${reportPath}`);

  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.error(
      `[run-eval] ${failed.length} scenario(s) failed: ${failed
        .map((r) => r.id)
        .join(", ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("[run-eval] all scenarios passed");
  }
}

main().catch((error) => {
  console.error("[run-eval] fatal error:", error);
  process.exit(1);
});

function scenarioMatchesFilters(scenario, filters) {
  const scenarioType = (scenario.type ?? "").toUpperCase();
  if (filters.typeFilter.length && !filters.typeFilter.includes(scenarioType)) {
    return false;
  }
  const scenarioModule =
    scenario.moduleHint ??
    scenario.metadata?.module ??
    scenario.metadata?.moduleHint ??
    null;
  if (filters.moduleFilter.length && (!scenarioModule || !filters.moduleFilter.includes(scenarioModule))) {
    return false;
  }
  if (filters.entityRegex) {
    const entityName =
      scenario.entity ??
      scenario.metadata?.entity ??
      scenario.metadata?.entityName ??
      null;
    if (!entityName || !filters.entityRegex.test(entityName)) {
      return false;
    }
  }
  return true;
}

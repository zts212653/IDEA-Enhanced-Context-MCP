#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function collectJavaFiles(root) {
  const stack = [root];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".java")) {
        files.push(absPath);
      }
    }
  }
  return files;
}

function inferModule(root, absPath) {
  const relative = path.relative(root, absPath);
  const [module] = relative.split(path.sep);
  return module ?? "";
}

const STRIP_SUFFIXES = [
  "RestController",
  "Controller",
  "Resource",
  "Repository",
  "Service",
  "Manager",
  "Assembler",
  "Mapper",
  "Converter",
  "Request",
  "Response",
  "Record",
  "Dto",
  "DTO",
  "Entity",
  "Impl",
  "Application",
  "Config",
  "Configuration",
  "Test",
  "Tests",
];

function deriveEntityName(className) {
  let current = className;
  while (true) {
    let updated = current;
    for (const suffix of STRIP_SUFFIXES) {
      if (updated.length <= suffix.length) continue;
      if (updated.endsWith(suffix)) {
        updated = updated.slice(0, -suffix.length);
      }
    }
    if (updated === current) {
      return current;
    }
    current = updated;
  }
}

function inferEntityName(absPath) {
  const className = path.basename(absPath).replace(/\.java$/i, "");
  return deriveEntityName(className);
}

function classifyFile(absPath) {
  const lower = absPath.toLowerCase();
  const className = path.basename(absPath).replace(/\.java$/i, "");
  if (lower.includes(`${path.sep}test${path.sep}`) || /test$/i.test(className)) {
    return "TEST";
  }
  if (
    lower.includes(`${path.sep}model${path.sep}`) ||
    lower.includes(`${path.sep}entity${path.sep}`) ||
    lower.includes(`${path.sep}domain${path.sep}`)
  ) {
    return "ENTITY";
  }
  if (
    /controller$/i.test(className) ||
    /resource$/i.test(className) ||
    lower.includes(`${path.sep}web${path.sep}`)
  ) {
    return "CONTROLLER";
  }
  if (/repository$/i.test(className) || lower.includes(`${path.sep}repository${path.sep}`)) {
    return "REPOSITORY";
  }
  if (
    /dto$/i.test(className) ||
    /request$/i.test(className) ||
    /response$/i.test(className) ||
    lower.includes(`${path.sep}dto${path.sep}`)
  ) {
    return "DTO";
  }
  if (/service$/i.test(className) || lower.includes(`${path.sep}service${path.sep}`)) {
    return "SERVICE";
  }
  if (/application$/i.test(className)) {
    return "APPLICATION";
  }
  return "OTHER";
}

function isMeaningfulEntityName(name) {
  if (!name) return false;
  if (name.length < 3) return false;
  if (/^abstract/i.test(name)) return false;
  if (/application$/i.test(name)) return false;
  if (/config(uration)?$/i.test(name)) return false;
  return true;
}

function buildScenarioId(prefix, name) {
  return `${prefix}-${name}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function recordBucket(map, key, factory) {
  if (!map.has(key)) {
    map.set(key, factory());
  }
  return map.get(key);
}

function sortBuckets(buckets) {
  return buckets.sort((a, b) => {
    const moduleCompare = a.module.localeCompare(b.module);
    if (moduleCompare !== 0) return moduleCompare;
    return a.entityName.localeCompare(b.entityName);
  });
}

function buildEntityBuckets(javaFiles, projectRoot) {
  const buckets = new Map();
  for (const absPath of javaFiles) {
    const category = classifyFile(absPath);
    if (category === "OTHER" || category === "APPLICATION" || category === "TEST") {
      continue;
    }
    const entityName = inferEntityName(absPath);
    if (!isMeaningfulEntityName(entityName)) continue;
    const module = inferModule(projectRoot, absPath);
    const key = `${module}:${entityName.toLowerCase()}`;
    const bucket = recordBucket(buckets, key, () => ({
      entityName,
      module,
      categories: new Set(),
    }));
    bucket.categories.add(category);
  }
  return sortBuckets(Array.from(buckets.values()));
}

function filterBuckets(buckets, predicate) {
  return buckets.filter(predicate);
}

function matchesBucketFilters(bucket, moduleFilter, entityRegex) {
  if (moduleFilter.length && !moduleFilter.includes(bucket.module)) {
    return false;
  }
  if (entityRegex && !entityRegex.test(bucket.entityName)) {
    return false;
  }
  return true;
}

function scenarioTypeAllowed(type, typeFilter) {
  if (!typeFilter.length) return true;
  return typeFilter.includes(type);
}

function withMetadata(base, metadata = {}) {
  return {
    ...base,
    metadata: {
      type: base.type,
      module: base.moduleHint ?? metadata.module ?? null,
      entity: base.entity ?? metadata.entity ?? null,
    },
  };
}

async function resolveProjectRoot(args) {
  const candidates = [];
  if (args.projectRoot) candidates.push(args.projectRoot);
  if (process.env.SCENARIO_PROJECT_ROOT) {
    candidates.push(process.env.SCENARIO_PROJECT_ROOT);
  }
  candidates.push(path.resolve(repoRoot, "..", "spring-petclinic-microservices"));
  candidates.push(path.resolve(repoRoot, "..", "..", "spring-petclinic-microservices"));
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const projectRoot = await resolveProjectRoot(args);
  if (!projectRoot) {
    console.error("[scenario-generator] project root not found (set --projectRoot or SCENARIO_PROJECT_ROOT)");
    process.exit(1);
  }

  const outputPath =
    args.output ??
    path.resolve(repoRoot, "..", "tmp", "eval-scenarios.json");
  const perEntity = Math.max(1, Number(args.perEntity ?? "1"));
  const restLimit = Number(args.restLimit ?? "10");
  const impactLimit = Number(args.impactLimit ?? "10");
  const moduleFilter = parseListArg(args.moduleFilter);
  const entityRegex = args.entityRegex ? new RegExp(args.entityRegex, "i") : null;
  const typeFilter = parseListArg(args.typeFilter).map((entry) => entry.toUpperCase());

  const javaFiles = await collectJavaFiles(projectRoot);
  const entityBuckets = buildEntityBuckets(javaFiles, projectRoot);

  const restBuckets = filterBuckets(entityBuckets, (bucket) =>
    bucket.categories.has("CONTROLLER") &&
    matchesBucketFilters(bucket, moduleFilter, entityRegex),
  );
  const impactBuckets = filterBuckets(entityBuckets, (bucket) =>
    (bucket.categories.has("ENTITY") || bucket.categories.has("REPOSITORY") || bucket.categories.has("DTO")) &&
    matchesBucketFilters(bucket, moduleFilter, entityRegex),
  );

  const scenarios = [];

  if (scenarioTypeAllowed("ENTRYPOINTS", typeFilter)) {
    scenarios.push(
      withMetadata({
        id: "q1-entrypoints",
        type: "ENTRYPOINTS",
        query: "Show me all Spring Boot service entry points across microservices",
      }),
    );
  }
  if (scenarioTypeAllowed("DISCOVERY_DEPS", typeFilter)) {
    scenarios.push(
      withMetadata({
        id: "q2-discovery",
        type: "DISCOVERY_DEPS",
        query: "Which services depend on the discovery server?",
      }),
    );
  }
  if (scenarioTypeAllowed("ALL_BEANS", typeFilter)) {
    scenarios.push(
      withMetadata({
        id: "q5-beans",
        type: "ALL_BEANS",
        query: "Show me all Spring beans in the entire project",
        maxContextTokens: 4000,
      }),
    );
  }

  const restSample = restBuckets.slice(0, restLimit);
  const impactSample = impactBuckets.slice(0, impactLimit);

  if (scenarioTypeAllowed("REST_ENDPOINTS", typeFilter)) {
    for (const bucket of restSample) {
      for (let i = 0; i < perEntity; i += 1) {
        scenarios.push(
          withMetadata(
            {
              id: buildScenarioId("rest", `${bucket.module}-${bucket.entityName}-${i}`),
              type: "REST_ENDPOINTS",
              entity: bucket.entityName,
              moduleHint: bucket.module,
              preferredLevels: ["module", "class", "method"],
              query: `Find all REST endpoints that handle ${bucket.entityName} records`,
            },
            { module: bucket.module, entity: bucket.entityName },
          ),
        );
      }
    }
  }

  if (scenarioTypeAllowed("ENTITY_IMPACT", typeFilter)) {
    for (const bucket of impactSample) {
      for (let i = 0; i < perEntity; i += 1) {
        scenarios.push(
          withMetadata(
            {
              id: buildScenarioId("impact", `${bucket.module}-${bucket.entityName}-${i}`),
              type: "ENTITY_IMPACT",
              entity: bucket.entityName,
              moduleHint: bucket.module,
              preferredLevels: ["module", "class", "method"],
              query: `If I change the ${bucket.entityName} schema, what controllers, repositories, and DTOs will be affected?`,
            },
            { module: bucket.module, entity: bucket.entityName },
          ),
        );
      }
    }
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(scenarios, null, 2));
  console.log(
    `[scenario-generator] wrote ${scenarios.length} scenarios to ${outputPath}`,
  );
  console.log(
    `[scenario-generator] buckets discovered: ${entityBuckets.length} (rest candidates=${restBuckets.length}, impact candidates=${impactBuckets.length})`,
  );
}

main().catch((error) => {
  console.error("[scenario-generator] failed:", error);
  process.exit(1);
});

# Evaluation & Scenario Harness

Use this guide to generate scenario corpora and run property-based evaluations for the MCP search pipeline. The harness has two layers:

1. **Scenario generator (`generate_scenarios.mjs`)** – samples entities/modules from a source tree and emits templated questions.
2. **Evaluator (`run_eval.mjs`)** – executes MCP searches for both fixed regression scenarios (Q1–Q5) and generated scenarios, then validates structural properties defined in `doc/SCENARIO_REGRESSION.md`.

## 1. Generate Scenario Samples

```
cd mcp-server
node scripts/generate_scenarios.mjs \
  --projectRoot=/Users/lysander/projects/spring-petclinic-microservices \
  --output=../tmp/eval-scenarios.json \
  --perEntity=1 \
  --moduleFilter=spring-petclinic-visits-service \
  --entityRegex='Visit|Vet'
```

- `projectRoot` (default: `../spring-petclinic-microservices`) – path to the codebase to scan.
- `output` (default: `../tmp/eval-scenarios.json`) – JSON file that will contain generated scenarios.
- `perEntity` – number of scenarios to emit per entity class.
- `moduleFilter` – optional comma-separated list of modules to include (e.g., `spring-petclinic-visits-service,spring-petclinic-vets-service`).
- `entityRegex` – optional regex applied to inferred entity names (`'Visit|Vet|Owner'`).
- `typeFilter` – optional comma-separated set of scenario types to emit (`REST_ENDPOINTS,ENTITY_IMPACT,ENTRYPOINTS,DISCOVERY_DEPS,ALL_BEANS`).

The generator discovers entity candidates by scanning `src/main/java/**/Visit*.java` (or other entity/model files), then produces templated questions for REST endpoints and entity-impact analysis, plus global entrypoint/discovery/bean scenarios. All scenario structs include `id`, `type`, and `query`, plus optional metadata (`entity`, `moduleHint`, `maxContextTokens`).

## 2. Run Evaluations

```
cd mcp-server
source ../.venv/bin/activate
DISABLE_SCHEMA_CHECK=1 \
PREFERRED_LEVELS=module,class,method \
MAX_CONTEXT_TOKENS=9000 \
node scripts/run_eval.mjs \
  --scenarios=../tmp/eval-scenarios.json \
  --moduleFilter=spring-petclinic-visits-service \
  --entityRegex='Visit|Vet' \
  --typeFilter=REST_ENDPOINTS,ENTITY_IMPACT
```

- Fixed scenarios (Q1–Q5) are always evaluated unless filtered out via `--typeFilter`.
- Pass `--scenarios=<comma-separated files>` to include generated questions.
- Optional filters to focus runs:
  - `--moduleFilter=spring-petclinic-visits-service` – only run scenarios whose module hint matches the list.
  - `--entityRegex='Visit|Vet|Owner'` – restrict to matching entity names.
  - `--typeFilter=REST_ENDPOINTS,ENTITY_IMPACT` – restrict to specific scenario categories.
- Ensure proxy variables are cleared (see `doc/mcp-grpc-troubleshooting.md`) so Node can reach local Milvus.

The script launches the MCP server per query (via `StdioClientTransport`), captures the structured JSON response, and applies the property checks from `doc/SCENARIO_REGRESSION.md`. For example:

- Entry points → expect `ENTRYPOINT` roles per service.
- Discovery deps → expect both `DISCOVERY_SERVER` and `DISCOVERY_CLIENT`.
- REST endpoints → expect controllers/endpoints referencing the sampled entity.
- Entity impact → expect grouped role summaries with `metadata.visitImpact`.
- Beans breadth → expect ≥15 beans and sizeable context budget usage.

## 3. Fixture 模式（CI 专用）

某些环境（例如 GitHub Actions）无法访问真实的 Milvus / IDEA Bridge。此时可以使用内置的 Petclinic fixture 数据来验证 search pipeline 的 staged search / contextBudget 逻辑。

1. 设置 `CI_FIXTURE=1`（或 `MCP_EVAL_FIXTURE=1`）。
2. 运行 evaluator 时附加 `--fixtureOnly`，仅对 fixture 覆盖的场景做 pass/fail 判断，其余场景会被标记为 `skipped`。

```
CI_FIXTURE=1 \
DISABLE_SCHEMA_CHECK=1 \
PREFERRED_LEVELS=module,class,method \
MAX_CONTEXT_TOKENS=9000 \
node scripts/run_eval.mjs \
  --scenarios=../tmp/eval-scenarios.json \
  --fixtureOnly
```

- fixture 数据来源：`mcp-server/fixtures/petclinic-fixtures.json`。
- 本地 / 真实环境调试 Milvus 时，不设置 `CI_FIXTURE`，也不要带 `--fixtureOnly`，即可恢复线上行为。

## 4. Reports

- Console output prints pass/fail per scenario.
- A structured report is written to `tmp/eval-report.json`, e.g.:

```json
[
  {
    "id": "q3-visit-endpoints",
    "type": "REST_ENDPOINTS",
    "pass": true,
    "reason": "REST endpoints located",
    "metrics": { "delivered": 1, "usedTokens": 20 }
  },
  {
    "id": "rest-visit-0",
    "type": "REST_ENDPOINTS",
    "pass": true,
    "reason": "REST endpoints located",
    "metrics": { "delivered": 1, "usedTokens": 20 }
  }
]
```

Use the regression doc (`doc/SCENARIO_REGRESSION.md`) and templates (`doc/SCENARIO_TEMPLATES.md`) when extending the evaluator or adding new capability checks.

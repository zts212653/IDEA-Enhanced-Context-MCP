# Scenario Regression Suite

This document defines the fixed question set we use to guard the embedding → Milvus → MCP search pipeline against regressions. Each scenario focuses on a capability (entrypoints, discovery dependencies, REST endpoints, entity impact, bean breadth). The checks are property based; they describe **structural expectations** that every response must satisfy rather than hardcoding specific answer text. This lets us reuse the suite for other Java projects that expose similar metadata.

| ID | Name | Query |
| --- | --- | --- |
| Q1 | Spring Boot entrypoints | `Show me all Spring Boot service entry points across microservices` |
| Q2 | Discovery dependencies | `Which services depend on the discovery server?` |
| Q3 | Visit entity REST endpoints | `Find all REST endpoints that handle pet visit records` |
| Q4 | Visit entity impact | `If I change the Visit entity schema, what controllers, repositories, and DTOs will be affected?` |
| Q5 | Spring bean breadth | `Show me all Spring beans in the entire project` |

## Q1 – Spring Boot entrypoints across microservices

- **Capability**: enumerate microservice entrypoints annotated with `@SpringBootApplication` (and related annotations).
- **Properties**:
  - Delivered results should contain at least one item per deployable module (admin-server, api-gateway, customers-service, vets-service, visits-service, discovery-server).
  - Every item must include `roles` containing `ENTRYPOINT`. Discovery-enabled services may also include `DISCOVERY_CLIENT` / `DISCOVERY_SERVER`.
  - Results should be grouped or summarized at module/class level (one entrypoint per module) rather than listing arbitrary beans.

## Q2 – Discovery server dependencies

- **Capability**: summarize which services act as discovery server vs clients.
- **Properties**:
  - At least one result’s `roles` contains `DISCOVERY_SERVER`.
  - At least one result’s `roles` contains `DISCOVERY_CLIENT`.
  - Preferred output structure: module-level items with `metadata.moduleMembers` describing the classes in that module (e.g., discovery server application class).
  - The list should emphasize modules, not a flat list of methods.

## Q3 – Visit entity REST endpoints

- **Capability**: locate REST controllers/endpoints for the Visit entity.
- **Properties**:
  - Delivered results include at least one item whose `module` is `spring-petclinic-visits-service`.
  - `roles` for at least one result includes `REST_ENDPOINT` or `REST_CONTROLLER`.
  - The `fqn`, `summary`, or `metadata.endpoints` mention `Visit`.
  - If `metadata.endpoints` exists, each descriptor should expose HTTP verb/path information (POST/GET for `/owners/*/pets/{petId}/visits`, etc.).

## Q4 – Visit entity impact analysis

- **Capability**: describe the blast radius when the Visit entity schema changes.
- **Properties**:
  - Results are grouped by inferred role (ENTITY, REPOSITORY, CONTROLLER, DTO, TEST, OTHER). Each group summarises how many matches exist and lists `metadata.visitImpact`.
  - `metadata.visitImpact` entries include at least the Visit entity, Visit repository, Visit controller/resource; DTO/test entries appear when data exists.
  - Role summaries should reference Visit-related files (filePath containing `visits` or `Visit`).
  - Module-level fallbacks are acceptable only after groups have been produced.

## Q5 – Spring beans breadth (context budget stress)

- **Capability**: return a wide view of Spring beans with controlled context budgeting.
- **Properties**:
  - Delivered results count ≥ 15 (aim for dozens of beans).
  - `contextBudget.usedTokens` should be a significant portion of `MAX_CONTEXT_TOKENS` (≥ 400 when `MAX_CONTEXT_TOKENS=4000`).
  - Each result includes `inferredRoles` such as `SPRING_BEAN`, `REST_CONTROLLER`, `REPOSITORY`, or `CONFIG`.
  - On larger projects the response should eventually set `contextBudget.truncated=true` or `omittedCount>0`; for petclinic it is acceptable if not yet truncated but the budget must still be substantially used.

Use these properties when implementing automated checks (see `mcp-server/scripts/run_eval.mjs`). Any change that violates the properties should be treated as a regression.

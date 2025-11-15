# Scenario Templates (Capability Abstractions)

This document captures the reusable “ability templates” behind the fixed Petclinic regression questions. Templates describe the capability in natural language plus a canonical query shape. When generating new scenarios automatically, replace the bracketed placeholders (e.g., `<ENTITY>`, `<MODULE>`) with real data discovered from PSI/Milvus or source code.

## EntryPoint Enumeration

- **Capability**: list all microservice entry points (typically classes annotated with `@SpringBootApplication`) to give operators an overview of deployable services.
- **Query template**: `Show all Spring Boot service entry points across microservices` (optionally mention project name).
- **Hints**: works at module/class level; expect per-module entrypoint information.

## Discovery Dependency Map

- **Capability**: identify which services act as discovery server versus discovery clients (Eureka/Consul/Nacos).
- **Query template**: `Which services depend on the discovery server?` or `List the microservices registered with <DISCOVERY_SERVICE_NAME>.`
- **Hints**: results should reveal both server and client roles; grouping by module is encouraged.

## REST Endpoint (Entity-centric)

- **Capability**: enumerate HTTP endpoints that handle a specific entity.
- **Query template**: `Find all REST endpoints that handle <ENTITY> records.`
- **Hints**: ties entity names to controllers/methods; look for annotations such as `@GetMapping`, `@PostMapping`.

## Entity Impact Analysis

- **Capability**: show all code artifacts affected by changing an entity schema (controllers, repositories, DTOs, tests, etc.).
- **Query template**: `If I change the <ENTITY> schema, what controllers, repositories, DTOs, and tests will be affected?`
- **Hints**: responses should group results by role; include file paths and module context.

## Spring Bean Breadth / Context Budget Stress

- **Capability**: surface a project-wide list of Spring beans (stereotypes, configuration classes, etc.) while honoring context limits.
- **Query template**: `Show me all Spring beans in the entire project` (optionally add constraints like “limit output to N tokens”).
- **Hints**: focus on breadth over depth; ensure token usage and truncation metadata indicate how the budgeting behaves.

## Extending Templates

- New capabilities can piggyback on these patterns. For example:
  - **Module onboarding**: `Summarize every module in <PROJECT> and their responsibilities.`
  - **Dependency impact**: `If I remove <LIBRARY> from <MODULE>, what classes fail to compile?`
- When adding new templates, follow the same structure: capability description, textual template, and hints about expected metadata.

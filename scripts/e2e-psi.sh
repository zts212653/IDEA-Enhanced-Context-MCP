#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDEA_PSI_EXPORTER="$PROJECT_ROOT/idea-psi-exporter"
IDEA_BRIDGE="$PROJECT_ROOT/idea-bridge"
MCP_SERVER="$PROJECT_ROOT/mcp-server"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$IDEA_PSI_EXPORTER/.gradle-local}"

echo "==> (1/4) Building IntelliJ PSI exporter"
(
  cd "$IDEA_PSI_EXPORTER"
  GRADLE_USER_HOME="$GRADLE_USER_HOME" ./gradlew clean build
)

echo "==> (2/4) Ingesting sample repo into Milvus"
(
  cd "$IDEA_BRIDGE"
  npm run ingest:milvus
)

echo "==> (3/4) Running MCP search sanity check"
node <<'NODE'
const { createSearchPipeline } = require("../mcp-server/dist/searchPipeline.js");
const { createMilvusSearchClient } = require("../mcp-server/dist/milvusClient.js");
(async () => {
  const pipeline = createSearchPipeline({
    bridgeClient: undefined,
    milvusClient: createMilvusSearchClient(),
    fallbackSymbols: [],
  });
  const outcome = await pipeline.search({ query: "service", limit: 5 });
  console.log(JSON.stringify(outcome, null, 2));
})();
NODE

echo "==> (4/4) Completed end-to-end verification"

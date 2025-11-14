import { loadConfig } from "../config.js";
import { buildSymbolRecords } from "../indexer.js";

async function run() {
  const config = loadConfig();
  const records = await buildSymbolRecords({ projectRoot: config.projectRoot });
  console.log(JSON.stringify({ projectRoot: config.projectRoot, records }, null, 2));
}

run().catch((error) => {
  console.error("Failed to export symbols", error);
  process.exitCode = 1;
});

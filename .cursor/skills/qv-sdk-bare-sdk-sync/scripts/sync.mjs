#!/usr/bin/env node
/**
 * Compatibility shim — prefer:
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-bare-sdk.mjs
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(
  __dirname,
  "..",
  "..",
  "qv-sdk-lockstep-sync",
  "scripts",
  "sync-bare-sdk.mjs",
);

const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);

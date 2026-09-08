#!/usr/bin/env node
/**
 * Stamp the @qvac/inference version anchor onto @qvac/sdk so a release cut
 * ships one shared version on the lockstep-released packages.
 *
 * @qvac/inference is the sole version anchor. sdk follows it; sdk-python
 * follows via generate.py (which reads sdk's version).
 *
 * Stamps the anchor version into:
 *   - packages/sdk/package.json (sdk follows inference)
 *
 * Does NOT touch dependency ranges. Those stay authored in sdk's package.json.
 *
 * Run from monorepo root (prefer /qv-sdk-lockstep-sync for the full client set):
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs           # apply
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs --dry-run # preview
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs --check   # exit 1 if drift
 *
 * NOTE: This script updates sdk's package.json. After running it:
 *   1. Regenerate sdk-python (`generate.py`) so its SDK_VERSION follows.
 *   2. Review staged changes and commit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const inferencePkgPath = path.join(repoRoot, "packages", "inference", "package.json");
const sdkPkgPath = path.join(repoRoot, "packages", "sdk", "package.json");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkMode = args.has("--check");

function readPkg(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writePkg(filePath, pkg) {
  // Preserve trailing newline; match repo's package.json formatting (2 spaces).
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
}

const inferencePkg = readPkg(inferencePkgPath);
const sdkPkg = readPkg(sdkPkgPath);

// @qvac/inference is the version anchor for the whole SDK pod.
const anchorVersion = inferencePkg.version;

let sdkDirty = false;
const changes = [];

if (sdkPkg.version !== anchorVersion) {
  changes.push({ kind: "version", field: "version (sdk)", from: sdkPkg.version, to: anchorVersion });
  sdkPkg.version = anchorVersion;
  sdkDirty = true;
}

if (changes.length === 0) {
  console.log(`[sync-sdk-pod] OK: sdk at the @qvac/inference anchor (${anchorVersion}).`);
  process.exit(0);
}

const summary = changes
  .map((c) => {
    if (c.kind === "version") {
      return `  ${c.field}: ${c.from} → ${c.to} (anchor @qvac/inference@${anchorVersion})`;
    }
    return `  ~ ${c.field}: ${c.from} → ${c.to}`;
  })
  .join("\n");

if (checkMode) {
  console.error(`[sync-sdk-pod] FAIL: drift detected (${changes.length} change(s)):`);
  console.error(summary);
  console.error("\nFix: run `node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs`");
  process.exit(1);
}

console.log(`[sync-sdk-pod] ${dryRun ? "DRY RUN" : "APPLY"}: ${changes.length} change(s):`);
console.log(summary);

if (dryRun) {
  console.log("\n[sync-sdk-pod] (no files written; rerun without --dry-run to apply)");
  process.exit(0);
}

if (sdkDirty) {
  writePkg(sdkPkgPath, sdkPkg);
  console.log("\n[sync-sdk-pod] wrote packages/sdk/package.json");
}
console.log("[sync-sdk-pod] next steps:");
console.log("  1. regenerate sdk-python so SDK_VERSION follows (packages/sdk-python/scripts/generate.py)");
console.log("  2. review staged changes and commit");

#!/usr/bin/env node
/**
 * Mirror @qvac/sdk → @qvac/bare-sdk package metadata to prevent drift
 * between the two lockstep-released packages.
 *
 * Mirrors:
 *   - version
 *   - shared dependencies entries (sdk → bare-sdk, version range)
 *   - shared optionalDependencies entries (only existing ones, no adds)
 *   - shared peerDependencies entries (only existing ones, no adds)
 *
 * Prunes:
 *   - dependencies entries that sdk no longer declares (so dropping a dep
 *     from sdk doesn't leave bare-sdk with an "extra dep" violation of
 *     check-deps-vs-sdk). Scoped to `dependencies` only — opt/peer asymmetry
 *     is intentional (bare-sdk omits Expo/Pear/RN/MCP).
 *
 * Skips:
 *   - PLUGIN_ADDONS (bare-sdk intentionally excludes addon plugin packages)
 *   - SDK_ONLY_PACKAGES (sdk-only carve-outs declared in check-deps-vs-sdk.mjs)
 *   - Any opt/peer dep not already declared by bare-sdk (asymmetric by design;
 *     bare-sdk skips Expo/Pear/RN/MCP optional deps)
 *
 * Does NOT mirror:
 *   - keywords, description, repository, exports, imports, files, scripts,
 *     devDependencies, peerDependenciesMeta. These intentionally diverge.
 *
 * Run from monorepo root:
 *   node .cursor/skills/qv-sdk-bare-sdk-sync/scripts/sync.mjs           # apply
 *   node .cursor/skills/qv-sdk-bare-sdk-sync/scripts/sync.mjs --dry-run # preview
 *   node .cursor/skills/qv-sdk-bare-sdk-sync/scripts/sync.mjs --check   # exit 1 if drift
 *
 * NOTE: This script only updates bare-sdk's package.json. After running it:
 *   1. Run `cd packages/bare-sdk && bun run check:deps-vs-sdk` to verify clean.
 *   2. Run `qv-notice-generate bare-sdk` to refresh bare-sdk's NOTICE.
 *   3. Review staged changes and commit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_ADDONS } from "../../../../packages/bare-sdk/scripts/plugin-addons.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const sdkPkgPath = path.join(repoRoot, "packages", "sdk", "package.json");
const bareSdkPkgPath = path.join(repoRoot, "packages", "bare-sdk", "package.json");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkMode = args.has("--check");

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
// Keep aligned with check-deps-vs-sdk.mjs's SDK_ONLY_PACKAGES. Empty today.
const SDK_ONLY_PACKAGES = new Set([]);

function readPkg(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writePkg(filePath, pkg) {
  // Preserve trailing newline; match repo's package.json formatting (2 spaces).
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
}

const sdkPkg = readPkg(sdkPkgPath);
const bareSdkPkg = readPkg(bareSdkPkgPath);

const changes = [];

// 1. Version
if (bareSdkPkg.version !== sdkPkg.version) {
  changes.push({
    kind: "version",
    field: "version",
    from: bareSdkPkg.version,
    to: sdkPkg.version,
  });
  bareSdkPkg.version = sdkPkg.version;
}

// 2. Dependency fields — add and update
for (const field of DEP_FIELDS) {
  const sdkDeps = sdkPkg[field] ?? {};
  const bareDeps = bareSdkPkg[field] ?? {};

  for (const [name, sdkRange] of Object.entries(sdkDeps)) {
    if (PLUGIN_ADDONS.has(name)) continue;
    if (SDK_ONLY_PACKAGES.has(name)) continue;

    // For `dependencies`, mirror missing entries too (bare-sdk should
    // strictly mirror sdk's runtime deps minus addons). For opt/peer,
    // only update existing entries — bare-sdk intentionally omits
    // Expo/Pear/RN/MCP opt deps and these should never be auto-added.
    const exists = name in bareDeps;
    const isDeps = field === "dependencies";

    if (!exists && !isDeps) continue;

    const bareRange = bareDeps[name];
    if (bareRange === sdkRange) continue;

    changes.push({
      kind: exists ? "update" : "add",
      field,
      name,
      from: bareRange ?? null,
      to: sdkRange,
    });

    if (!bareSdkPkg[field]) bareSdkPkg[field] = {};
    bareSdkPkg[field][name] = sdkRange;
  }
}

// 3. Prune `dependencies` entries sdk no longer declares.
// Without this, dropping a dep from sdk leaves bare-sdk with an "extra dep"
// that fails check-deps-vs-sdk and forces a manual cleanup. Scoped to
// `dependencies` only — opt/peer extras in bare-sdk are by design
// (bare-sdk omits Expo/Pear/RN/MCP from sdk's opt deps).
//
// PLUGIN_ADDONS aren't whitelisted here: if one ever ends up in bare-sdk's
// deps it's already a check-no-addon-deps violation; pruning it is correct.
const sdkDepsForPrune = sdkPkg.dependencies ?? {};
const bareDepsForPrune = bareSdkPkg.dependencies ?? {};
for (const name of Object.keys(bareDepsForPrune)) {
  if (name in sdkDepsForPrune) continue;
  if (SDK_ONLY_PACKAGES.has(name)) continue;

  changes.push({
    kind: "remove",
    field: "dependencies",
    name,
    from: bareDepsForPrune[name],
    to: null,
  });
  delete bareSdkPkg.dependencies[name];
}

if (changes.length === 0) {
  console.log("[sync-bare-sdk] OK: no drift between @qvac/sdk and @qvac/bare-sdk.");
  process.exit(0);
}

const summary = changes
  .map((c) => {
    if (c.kind === "version") {
      return `  version: ${c.from} → ${c.to}`;
    }
    if (c.kind === "add") {
      return `  + ${c.field}."${c.name}": "${c.to}"`;
    }
    if (c.kind === "remove") {
      return `  - ${c.field}."${c.name}": "${c.from}" (sdk no longer declares)`;
    }
    return `  ~ ${c.field}."${c.name}": "${c.from}" → "${c.to}"`;
  })
  .join("\n");

if (checkMode) {
  console.error(`[sync-bare-sdk] FAIL: drift detected (${changes.length} change(s)):`);
  console.error(summary);
  console.error("\nFix: run `node .cursor/skills/qv-sdk-bare-sdk-sync/scripts/sync.mjs`");
  process.exit(1);
}

console.log(`[sync-bare-sdk] ${dryRun ? "DRY RUN" : "APPLY"}: ${changes.length} change(s):`);
console.log(summary);

if (dryRun) {
  console.log("\n[sync-bare-sdk] (no files written; rerun without --dry-run to apply)");
  process.exit(0);
}

writePkg(bareSdkPkgPath, bareSdkPkg);
console.log("\n[sync-bare-sdk] wrote packages/bare-sdk/package.json");
console.log("[sync-bare-sdk] next steps:");
console.log("  1. cd packages/bare-sdk && bun run check:deps-vs-sdk");
console.log("  2. source .env && node .cursor/skills/qv-notice-generate/scripts/generate-notice.js bare-sdk");
console.log("  3. review staged changes and commit");

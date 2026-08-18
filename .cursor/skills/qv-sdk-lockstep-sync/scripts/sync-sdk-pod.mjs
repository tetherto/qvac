#!/usr/bin/env node
/**
 * Stamp the @qvac/inference version anchor across the SDK pod and mirror
 * @qvac/sdk → @qvac/bare-sdk package metadata, so a release cut ships one
 * shared version on every lockstep-released package.
 *
 * @qvac/inference is the sole version anchor. sdk and bare-sdk (here) follow
 * it; sdk-python follows via generate.py (which reads sdk's version).
 *
 * Stamps the anchor version into:
 *   - packages/sdk/package.json      (sdk follows inference)
 *   - packages/bare-sdk/package.json (bare-sdk follows inference)
 *
 * Mirrors @qvac/sdk → @qvac/bare-sdk:
 *   - shared dependencies entries (version range)
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
 * Run from monorepo root (prefer /qv-sdk-lockstep-sync for the full client set):
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs           # apply
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs --dry-run # preview
 *   node .cursor/skills/qv-sdk-lockstep-sync/scripts/sync-sdk-pod.mjs --check   # exit 1 if drift
 *
 * NOTE: This script updates sdk's and bare-sdk's package.json. After running it:
 *   1. Run `cd packages/bare-sdk && bun run check:deps-vs-sdk` to verify clean.
 *   2. Run `qv-notice-generate bare-sdk` to refresh bare-sdk's NOTICE.
 *   3. Regenerate sdk-python (`generate.py`) so its SDK_VERSION follows.
 *   4. Review staged changes and commit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_ADDONS } from "../../../../packages/bare-sdk/scripts/plugin-addons.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const inferencePkgPath = path.join(repoRoot, "packages", "inference", "package.json");
const sdkPkgPath = path.join(repoRoot, "packages", "sdk", "package.json");
const bareSdkPkgPath = path.join(repoRoot, "packages", "bare-sdk", "package.json");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkMode = args.has("--check");

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
// Keep aligned with check-deps-vs-sdk.mjs's SDK_ONLY_PACKAGES.
const SDK_ONLY_PACKAGES = new Set(["bare-runtime", "bare-pack"]);

function readPkg(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writePkg(filePath, pkg) {
  // Preserve trailing newline; match repo's package.json formatting (2 spaces).
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
}

const inferencePkg = readPkg(inferencePkgPath);
const sdkPkg = readPkg(sdkPkgPath);
const bareSdkPkg = readPkg(bareSdkPkgPath);

// @qvac/inference is the version anchor for the whole SDK pod.
const anchorVersion = inferencePkg.version;

let sdkDirty = false;
const changes = [];

// 1. Version — sdk and bare-sdk both follow the @qvac/inference anchor.
if (sdkPkg.version !== anchorVersion) {
  changes.push({ kind: "version", field: "version (sdk)", from: sdkPkg.version, to: anchorVersion });
  sdkPkg.version = anchorVersion;
  sdkDirty = true;
}
if (bareSdkPkg.version !== anchorVersion) {
  changes.push({
    kind: "version",
    field: "version (bare-sdk)",
    from: bareSdkPkg.version,
    to: anchorVersion,
  });
  bareSdkPkg.version = anchorVersion;
}

// 2. Dependency fields — add and update (sdk → bare-sdk)
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
  console.log(`[sync-sdk-pod] OK: sdk and bare-sdk both at the @qvac/inference anchor (${anchorVersion}).`);
  process.exit(0);
}

const summary = changes
  .map((c) => {
    if (c.kind === "version") {
      return `  ${c.field}: ${c.from} → ${c.to} (anchor @qvac/inference@${anchorVersion})`;
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
writePkg(bareSdkPkgPath, bareSdkPkg);
console.log("[sync-sdk-pod] wrote packages/bare-sdk/package.json");
console.log("[sync-sdk-pod] next steps:");
console.log("  1. cd packages/bare-sdk && bun run check:deps-vs-sdk");
console.log("  2. source .env && node .cursor/skills/qv-notice-generate/scripts/generate-notice.js bare-sdk");
console.log("  3. regenerate sdk-python so SDK_VERSION follows (packages/sdk-python/scripts/generate.py)");
console.log("  4. review staged changes and commit");

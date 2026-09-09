#!/usr/bin/env node
/**
 * Point @qvac/sdk at a published @qvac/inference version.
 *
 * The two expose the same API, so the SDK's own version and its @qvac/inference
 * dependency range must share a major and minor. Patch numbers are free on both
 * sides: @qvac/sdk 0.19.4 may depend on @qvac/inference ^0.19.2.
 *
 * The engine at that major.minor is published first (publish-inference.yml), so
 * the range this writes resolves from npm while the SDK release is under review.
 *
 * Run from the monorepo root (prefer /qv-sdk-inference-version for the full
 * release preparation, which also regenerates sdk-python):
 *
 *   node .cursor/skills/qv-sdk-inference-version/scripts/set-inference-version.mjs --check
 *   node .cursor/skills/qv-sdk-inference-version/scripts/set-inference-version.mjs --engine-version=0.20.0
 *   node .cursor/skills/qv-sdk-inference-version/scripts/set-inference-version.mjs --engine-version=0.20.0 --sdk-version=0.20.1
 *   node .cursor/skills/qv-sdk-inference-version/scripts/set-inference-version.mjs --engine-version=0.20.0 --dry-run
 *
 * --check reports a mismatch and exits 1 without writing. With --engine-version
 * it writes the range and, unless --sdk-version says otherwise, sets the SDK's
 * version to the same major.minor.
 *
 * After writing: regenerate sdk-python (`scripts/generate.py`) so SDK_VERSION
 * follows, then review and commit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const sdkPkgPath = path.join(repoRoot, "packages", "sdk", "package.json");
const dependency = "@qvac/inference";
const label = "[set-inference-version]";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => !arg.includes("=")));
const dryRun = flags.has("--dry-run");
const checkMode = flags.has("--check");

function readOption(name) {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

function parseVersion(value, what) {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(value);
  if (match === null) {
    console.error(`${label} ${what} must be x.y.z, got "${value}"`);
    process.exit(1);
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function majorMinorOf(parsed) {
  return `${parsed.major}.${parsed.minor}`;
}

// A caret holds a range inside one major.minor only below 1.0.0; from 1.0.0 up
// it reaches into the next minor, so a tilde is required there. The SDK's
// enforce-inference-versions lint step rejects the other form.
function rangeFor(version, parsed) {
  return `${parsed.major >= 1 ? "~" : "^"}${version}`;
}

const engineVersion = readOption("engine-version");
const sdkVersionOverride = readOption("sdk-version");

const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, "utf8"));
const currentVersion = sdkPkg.version;
const currentRange = sdkPkg.dependencies?.[dependency];

if (currentRange === undefined) {
  console.error(`${label} packages/sdk declares no ${dependency} dependency.`);
  process.exit(1);
}

if (engineVersion === undefined) {
  const sdkMajorMinor = majorMinorOf(parseVersion(currentVersion, "@qvac/sdk version"));
  const rangeMatch = /^[\^~](\d+)\.(\d+)\.\d+$/.exec(currentRange);
  const rangeMajorMinor = rangeMatch === null ? undefined : `${rangeMatch[1]}.${rangeMatch[2]}`;

  if (rangeMajorMinor === sdkMajorMinor) {
    console.log(
      `${label} OK: @qvac/sdk ${currentVersion} and ${dependency} ${currentRange} share major.minor ${sdkMajorMinor}.`
    );
    process.exit(0);
  }

  console.error(
    `${label} FAIL: @qvac/sdk ${currentVersion} is major.minor ${sdkMajorMinor}, ` +
      `${dependency} "${currentRange}" is${rangeMajorMinor === undefined ? " not a plain caret/tilde range" : ` major.minor ${rangeMajorMinor}`}.`
  );
  console.error(
    `\nFix: rerun with --engine-version=<the published @qvac/inference version to depend on>.`
  );
  process.exit(1);
}

const engineParsed = parseVersion(engineVersion, "--engine-version");
const targetRange = rangeFor(engineVersion, engineParsed);
const targetVersion = sdkVersionOverride ?? `${majorMinorOf(engineParsed)}.0`;
const targetParsed = parseVersion(targetVersion, "--sdk-version");

if (majorMinorOf(targetParsed) !== majorMinorOf(engineParsed)) {
  console.error(
    `${label} --sdk-version ${targetVersion} is major.minor ${majorMinorOf(targetParsed)}, ` +
      `but --engine-version ${engineVersion} is major.minor ${majorMinorOf(engineParsed)}. They must match.`
  );
  process.exit(1);
}

const changes = [];
if (currentVersion !== targetVersion) {
  changes.push(`  version (sdk): ${currentVersion} → ${targetVersion}`);
}
if (currentRange !== targetRange) {
  changes.push(`  dependencies.${dependency}: ${currentRange} → ${targetRange}`);
}

if (changes.length === 0) {
  console.log(`${label} OK: already at @qvac/sdk ${targetVersion} with ${dependency} ${targetRange}.`);
  process.exit(0);
}

if (checkMode) {
  console.error(`${label} FAIL: ${changes.length} edit(s) needed:`);
  console.error(changes.join("\n"));
  process.exit(1);
}

console.log(`${label} ${dryRun ? "DRY RUN" : "APPLY"}: ${changes.length} change(s):`);
console.log(changes.join("\n"));

if (dryRun) {
  console.log(`\n${label} (no files written; rerun without --dry-run to apply)`);
  process.exit(0);
}

sdkPkg.version = targetVersion;
sdkPkg.dependencies[dependency] = targetRange;
// Preserve trailing newline; match repo's package.json formatting (2 spaces).
fs.writeFileSync(sdkPkgPath, JSON.stringify(sdkPkg, null, 2) + "\n");

console.log(`\n${label} wrote packages/sdk/package.json`);
console.log(`${label} next steps:`);
console.log(`  1. confirm ${dependency}@${engineVersion} is published on npm`);
console.log("  2. regenerate sdk-python so SDK_VERSION follows (packages/sdk-python/scripts/generate.py)");
console.log("  3. run `bun run enforce-inference-versions` in packages/sdk");
console.log("  4. review staged changes and commit");

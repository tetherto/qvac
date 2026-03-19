#!/usr/bin/env bun
/**
 * Updates src/lib/versions.ts from content/docs/ version folders.
 *
 * Scans content/docs/ for top-level vX.Y.Z directories and the dev/ folder.
 * Supports deferred versioning: use --latest=X.Y.Z to specify the current
 * latest version when it has no vX.Y.Z folder yet.
 *
 * Usage:
 *   bun run scripts/update-versions-list.ts [version] [--latest=X.Y.Z]
 *
 * Arguments:
 *   version         Optional. After generating a new version, pass it to
 *                   verify it exists in the scan.
 *   --latest=X.Y.Z  Override which version is marked as latest.
 *                   Required when the current latest has no vX.Y.Z folder
 *                   (deferred versioning).
 */

import * as fs from "fs/promises";
import * as path from "path";

function compareSemverDesc(a: string, b: string): number {
  const aVer = a.replace(/^v/, "").split(".").map(Number);
  const bVer = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (aVer[i] !== bVer[i]) return bVer[i] - aVer[i];
  }
  return 0;
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function updateVersionsList(newVersion?: string, latestOverride?: string) {
  console.log(`📋 Updating versions list...`);

  const versionsFile = path.join(process.cwd(), "src", "lib", "versions.ts");
  const docsDir = path.join(process.cwd(), "content", "docs");

  let entries;
  try {
    entries = await fs.readdir(docsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Failed to read docs directory: ${docsDir}. Generate docs first.`
    );
  }

  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .sort(compareSemverDesc);

  console.log(`✓ Found ${versions.length} versioned folders:`, versions.join(", ") || "(none)");

  if (newVersion) {
    const normalized = newVersion.startsWith("v") ? newVersion : `v${newVersion}`;
    if (!versions.includes(normalized)) {
      throw new Error(
        `Version ${normalized} was not found in ${docsDir}. ` +
        `Did docs:generate-api run successfully for this version?`
      );
    }
    console.log(`✓ Confirmed ${normalized} is present`);
  }

  const hasDevApi = await dirExists(path.join(docsDir, "dev", "sdk", "api"));
  if (hasDevApi) {
    console.log(`✓ Found dev/sdk/api/`);
  }

  let latestVersion: string;
  if (latestOverride) {
    latestVersion = latestOverride.startsWith("v") ? latestOverride : `v${latestOverride}`;
    console.log(`✓ Using --latest override: ${latestVersion}`);
  } else if (versions.length > 0) {
    latestVersion = versions[0];
  } else {
    throw new Error(
      "No version directories found and no --latest override provided."
    );
  }

  const versionEntries: string[] = [];

  if (hasDevApi) {
    versionEntries.push(`  { label: 'dev', value: 'dev', isDev: true },`);
  }

  versionEntries.push(
    `  { label: 'latest (${latestVersion})', value: '${latestVersion}', isLatest: true },`
  );

  for (const v of versions) {
    if (v === latestVersion) continue;
    versionEntries.push(`  { label: '${v}', value: '${v}' },`);
  }

  const content = `export interface Version {
  label: string;
  value: string;
  isLatest?: boolean;
  isDev?: boolean;
}

export const VERSIONS: Version[] = [
${versionEntries.join("\n")}
];

export const LATEST_VERSION = '${latestVersion}';

const VERSION_PREFIX_RE = /^\\/(v\\d+\\.\\d+\\.\\d+|dev)(\\\/|$)/;

/**
 * Extract the version prefix from a URL pathname.
 * Returns null when on the (latest) version (no prefix in the URL).
 * @example getVersionFromPath('/v0.6.1/sdk/quickstart') → 'v0.6.1'
 * @example getVersionFromPath('/dev/sdk/api')           → 'dev'
 * @example getVersionFromPath('/sdk/quickstart')         → null
 */
export function getVersionFromPath(pathname: string): string | null {
  return pathname.match(VERSION_PREFIX_RE)?.[1] ?? null;
}

/**
 * Compute the equivalent URL for a different version.
 *
 * - latest → latest (no-op)
 * - latest → v0.6.1: prepend /v0.6.1
 * - v0.6.1 → latest: strip /v0.6.1
 * - v0.6.1 → v0.7.0: replace /v0.6.1 with /v0.7.0
 * - latest → dev: prepend /dev
 * - dev → latest: strip /dev
 */
export function computeVersionedUrl(
  pathname: string,
  targetVersion: string,
): string {
  const currentVersion = getVersionFromPath(pathname);
  const targetIsLatest = VERSIONS.find(
    (v) => v.value === targetVersion,
  )?.isLatest;

  if (currentVersion) {
    if (targetIsLatest) {
      return pathname.replace(\`/\${currentVersion}\`, '') || '/';
    }
    return pathname.replace(\`/\${currentVersion}\`, \`/\${targetVersion}\`);
  }

  if (targetIsLatest) return pathname;
  return \`/\${targetVersion}\${pathname}\`;
}
`;

  await fs.writeFile(versionsFile, content, "utf-8");
  console.log(`✅ Updated ${versionsFile}`);
  console.log(`   Latest: ${latestVersion}`);
  console.log(`   Total entries: ${versionEntries.length}${hasDevApi ? " (including dev)" : ""}`);
}

// CLI
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run scripts/update-versions-list.ts [version] [--latest=X.Y.Z]");
  console.log("");
  console.log("  version         Optional. Verify this version exists after scan.");
  console.log("  --latest=X.Y.Z  Override which version is marked as latest");
  console.log("                  (for deferred versioning where latest has no folder).");
  process.exit(0);
}

const latestFlag = args.find((a) => a.startsWith("--latest="));
const latestOverride = latestFlag?.split("=")[1];
const newVersion = args.find((a) => !a.startsWith("--"));

updateVersionsList(newVersion, latestOverride).catch((error) => {
  console.error("❌ Error updating versions list:", error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * Updates src/lib/versions.ts from content/docs/ version folders.
 *
 * Scans content/docs/ for top-level vX.Y.Z directories (excludes (latest)
 * and dot-prefixed dirs). The newest version is tagged as latest.
 *
 * Usage: bun run scripts/update-versions-list.ts [version]
 * Version arg is optional; if provided, ensures that version is included.
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

async function updateVersionsList(newVersion?: string) {
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

  console.log(`✓ Found ${versions.length} versions:`, versions.join(", ") || "(none)");

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

  if (versions.length === 0) {
    throw new Error(
      "No valid version directories (vX.Y.Z) found. Run docs:generate-api first."
    );
  }

  const latestVersion = versions[0];
  const content = `export interface Version {
  label: string;
  value: string;
  isLatest?: boolean;
}

export const VERSIONS: Version[] = [
${versions.map((v, i) => {
  const label = i === 0 ? `${v} (latest)` : v;
  const isLatest = i === 0 ? ", isLatest: true" : "";
  return `  { label: '${label}', value: '${v}'${isLatest} },`;
}).join("\n")}
];

export const LATEST_VERSION = '${latestVersion}';

const VERSION_PREFIX_RE = /^\\/(v\\d+\\.\\d+\\.\\d+)(\\\/|$)/;

/**
 * Extract the version prefix from a URL pathname.
 * Returns null when on the (latest) version (no prefix in the URL).
 * @example getVersionFromPath('/v0.6.1/sdk/quickstart') → 'v0.6.1'
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
  console.log(`   Total versions: ${versions.length}`);
}

const newVersion = process.argv[2];
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: bun run scripts/update-versions-list.ts [version]");
  console.log("  version  Optional. After generating a new version, pass it to refresh the list.");
  process.exit(0);
}

updateVersionsList(newVersion).catch((error) => {
  console.error("❌ Error updating versions list:", error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});

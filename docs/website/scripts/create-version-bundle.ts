#!/usr/bin/env bun
/**
 * Freeze the current `index.mdx` of a versioned section into a sibling
 * `v<X.Y.Z>.mdx` snapshot. Run this BEFORE replacing the index with new
 * content so the outgoing version remains accessible via the version
 * selector.
 *
 * Sections snapshotted by this script:
 *   - `content/docs/sdk/api/index.mdx`           → `v<version>.mdx`
 *   - `content/docs/sdk/release-notes/index.mdx` → `v<version>.mdx`
 *
 * Usage:
 *   bun run scripts/create-version-bundle.ts <outgoing-version>
 *
 * Example workflow when releasing v0.10.0 (current latest is v0.9.1):
 *   1. bun run scripts/create-version-bundle.ts 0.9.1
 *      Freezes the outgoing API summary and release notes.
 *   2. Generate v0.10.0 content:
 *      bun run scripts/generate-api-docs.ts 0.10.0 --latest
 *      bun run scripts/generate-release-notes.ts 0.10.0 --latest
 *   3. bun run scripts/update-versions-list.ts
 *      Refreshes the version selector dropdowns from disk.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");
const CONTENT_DOCS = path.join(DOCS_WEBSITE_DIR, "content", "docs");

const SECTIONS = [
  { name: "API summary", dir: path.join(CONTENT_DOCS, "sdk", "api") },
  { name: "release notes", dir: path.join(CONTENT_DOCS, "sdk", "release-notes") },
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function snapshotSection(
  sectionName: string,
  sectionDir: string,
  version: string,
  force: boolean,
): Promise<void> {
  const indexFile = path.join(sectionDir, "index.mdx");
  const snapshotFile = path.join(sectionDir, `v${version}.mdx`);

  if (!(await fileExists(indexFile))) {
    console.log(`  ⏭️  ${sectionName}: no index.mdx — skipping`);
    return;
  }
  if (await fileExists(snapshotFile)) {
    if (!force) {
      throw new Error(
        `${sectionName}: ${path.relative(CONTENT_DOCS, snapshotFile)} already exists. Use --force to overwrite.`,
      );
    }
    console.log(`  ⚠️  ${sectionName}: overwriting existing snapshot`);
  }

  await fs.copyFile(indexFile, snapshotFile);
  console.log(
    `  ✓ ${sectionName}: ${path.relative(CONTENT_DOCS, indexFile)} → ${path.relative(CONTENT_DOCS, snapshotFile)}`,
  );
}

async function createVersionBundle(version: string, force = false) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.9.1)`,
    );
  }

  console.log(`📦 Freezing v${version} from current index.mdx files...`);
  for (const section of SECTIONS) {
    await snapshotSection(section.name, section.dir, version, force);
  }
  console.log(`✅ Version bundle v${version} created.`);
  console.log(``);
  console.log(`Next steps:`);
  console.log(`  1. Update index.mdx with the new version's content.`);
  console.log(`  2. Run \`bun run scripts/update-versions-list.ts\``);
}

const args = process.argv.slice(2);
const versionArg = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");

if (!versionArg || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run scripts/create-version-bundle.ts <outgoing-version> [--force]");
  console.log("");
  console.log(
    "Freezes the current index.mdx for both versioned sections (API summary",
  );
  console.log("and release notes) into vX.Y.Z.mdx siblings.");
  console.log("");
  console.log("Flags:");
  console.log("  --force   Overwrite existing snapshots if present.");
  process.exit(versionArg ? 0 : 1);
}

createVersionBundle(versionArg, force).catch((err) => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});

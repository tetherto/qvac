#!/usr/bin/env bun
/**
 * Release a new docs version (API-only versioning).
 *
 * Freezes the current (latest) API docs as the outgoing version,
 * promotes dev API docs to (latest), and resets dev for the next cycle.
 *
 * Usage:
 *   bun run scripts/release-version.ts <new-version>
 *
 * Example (releasing v0.8.0 when current latest is v0.7.0):
 *   bun run scripts/release-version.ts 0.8.0
 *
 * This will:
 *   1. Freeze (latest)/sdk/api/ → v0.7.0/sdk/api/
 *   2. Create src/lib/trees/v0.7.0.ts (thin wrapper)
 *   3. Update src/lib/trees/index.ts
 *   4. Promote dev/sdk/api/ → (latest)/sdk/api/
 *   5. Reset dev/sdk/api/ from new (latest)/sdk/api/
 *   6. Update src/lib/versions.ts
 *   7. Commit changes
 *   8. Create PR to docs-production
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function readLatestVersion(): string {
  const versionsPath = path.join(process.cwd(), "src", "lib", "versions.ts");
  const content = require("fs").readFileSync(versionsPath, "utf-8");
  const match = content.match(/LATEST_VERSION\s*=\s*'([^']+)'/);
  if (!match) {
    throw new Error("Could not read LATEST_VERSION from src/lib/versions.ts");
  }
  return match[1];
}

function generateTreeFile(version: string): string {
  return `import type { Node } from 'fumadocs-core/page-tree';
import { tree as latestTree, findFolderChildren } from './latest';
import { source } from '@/lib/source';

export const tree: Node[] = latestTree.map(node =>
  node.type === 'folder' && node.name === 'JS API'
    ? {
        ...node,
        index: node.index ? { ...node.index, url: '/${version}/sdk/api' } : node.index,
        children: findFolderChildren(source.pageTree.children, '/${version}/sdk/api'),
      }
    : node
);
`;
}

function updateTreesIndex(indexContent: string, version: string): string {
  const safeVar = version.replace(/[^a-zA-Z0-9]/g, "");
  const importLine = `import { tree as ${safeVar}Tree } from './${version}';`;

  if (indexContent.includes(importLine)) {
    console.log(`✓ trees/index.ts already imports ${version}`);
    return indexContent;
  }

  let updated = indexContent.replace(
    /(import { tree as latestTree }[^\n]*\n)/,
    `$1${importLine}\n`
  );

  updated = updated.replace(
    /(\s*'latest': latestTree,)/,
    `\n    '${version}': ${safeVar}Tree,$1`
  );

  return updated;
}

async function releaseVersion(newVersion: string) {
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
    throw new Error(
      `Invalid version format: "${newVersion}"\nExpected semver: X.Y.Z (e.g., 0.8.0)`
    );
  }

  const docsDir = path.join(process.cwd(), "content", "docs");
  const treesDir = path.join(process.cwd(), "src", "lib", "trees");
  const latestApiDir = path.join(docsDir, "(latest)", "sdk", "api");
  const devApiDir = path.join(docsDir, "dev", "sdk", "api");
  const newVersionPrefixed = `v${newVersion}`;

  const outgoingVersion = readLatestVersion();
  console.log(`📦 Releasing docs ${newVersionPrefixed}`);
  console.log(`   Outgoing: ${outgoingVersion}`);
  console.log(`   Incoming: ${newVersionPrefixed}`);

  if (outgoingVersion === newVersionPrefixed) {
    throw new Error(
      `New version ${newVersionPrefixed} is the same as current latest. Nothing to do.`
    );
  }

  if (!(await dirExists(latestApiDir))) {
    throw new Error(`(latest)/sdk/api/ not found at ${latestApiDir}`);
  }
  if (!(await dirExists(devApiDir))) {
    throw new Error(`dev/sdk/api/ not found at ${devApiDir}`);
  }

  // Step 1: Freeze (latest)/sdk/api/ → v{outgoing}/sdk/api/
  const outgoingApiDir = path.join(docsDir, outgoingVersion, "sdk", "api");
  console.log(`\n1️⃣  Freezing ${outgoingVersion} API docs...`);
  await fs.rm(outgoingApiDir, { recursive: true, force: true });
  await fs.mkdir(path.join(docsDir, outgoingVersion, "sdk"), { recursive: true });
  await fs.cp(latestApiDir, outgoingApiDir, { recursive: true });
  console.log(`✓ Copied (latest)/sdk/api/ → ${outgoingVersion}/sdk/api/`);

  // Step 2: Create versioned tree file
  console.log(`\n2️⃣  Creating ${outgoingVersion} tree...`);
  const treePath = path.join(treesDir, `${outgoingVersion}.ts`);
  await fs.writeFile(treePath, generateTreeFile(outgoingVersion), "utf-8");
  console.log(`✓ Created trees/${outgoingVersion}.ts`);

  // Step 3: Update trees/index.ts
  console.log(`\n3️⃣  Updating trees/index.ts...`);
  const indexPath = path.join(treesDir, "index.ts");
  const indexContent = await fs.readFile(indexPath, "utf-8");
  const updatedIndex = updateTreesIndex(indexContent, outgoingVersion);
  await fs.writeFile(indexPath, updatedIndex, "utf-8");
  console.log(`✓ Updated trees/index.ts`);

  // Step 4: Promote dev/sdk/api/ → (latest)/sdk/api/
  console.log(`\n4️⃣  Promoting dev API docs to (latest)...`);
  await fs.rm(latestApiDir, { recursive: true, force: true });
  await fs.cp(devApiDir, latestApiDir, { recursive: true });
  console.log(`✓ Replaced (latest)/sdk/api/ with dev/sdk/api/`);

  // Step 5: Reset dev/sdk/api/ from new (latest)/sdk/api/
  console.log(`\n5️⃣  Resetting dev API docs...`);
  await fs.rm(devApiDir, { recursive: true, force: true });
  await fs.cp(latestApiDir, devApiDir, { recursive: true });
  console.log(`✓ Reset dev/sdk/api/ from new (latest)/sdk/api/`);

  // Step 6: Update versions.ts
  console.log(`\n6️⃣  Updating versions list...`);
  execSync(
    `bun run scripts/update-versions-list.ts --latest=${newVersion}`,
    { stdio: "inherit", cwd: process.cwd() }
  );

  // Step 7: Commit
  console.log(`\n7️⃣  Committing changes...`);
  try {
    execSync(`git add -A`, { stdio: "inherit", cwd: process.cwd() });
    execSync(
      `git commit -m "doc: release docs ${newVersionPrefixed}"`,
      { stdio: "inherit", cwd: process.cwd() }
    );
    console.log(`✓ Committed to current branch`);
  } catch {
    console.log(`⚠️  Git commit skipped (no changes or not a git repo)`);
  }

  // Step 8: Create PR to docs-production
  console.log(`\n8️⃣  Creating PR to docs-production...`);
  try {
    execSync(`git push -u origin HEAD`, { stdio: "inherit", cwd: process.cwd() });
    execSync(
      `gh pr create --base docs-production --head main --title "doc: release docs ${newVersionPrefixed}" --body "Promotes ${newVersionPrefixed} API docs to latest.\nFreezes ${outgoingVersion} API docs as versioned snapshot."`,
      { stdio: "inherit", cwd: process.cwd() }
    );
    console.log(`✓ PR created`);
  } catch {
    console.log(`⚠️  PR creation skipped (gh CLI not available or PR already exists)`);
  }

  console.log(`\n✅ Release ${newVersionPrefixed} complete`);
  console.log(`   Frozen: ${outgoingVersion}/sdk/api/`);
  console.log(`   Latest: (latest)/sdk/api/ (now ${newVersionPrefixed})`);
  console.log(`   Dev: dev/sdk/api/ (reset, ready for next version)`);
}

// CLI
const args = process.argv.slice(2);
const versionArg = args.find((a) => !a.startsWith("--"));

if (!versionArg || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run scripts/release-version.ts <new-version>");
  console.log("");
  console.log("Releases a new docs version by freezing the outgoing API docs,");
  console.log("promoting dev API docs to latest, and resetting dev.");
  console.log("");
  console.log("Example (releasing v0.8.0 when current latest is v0.7.0):");
  console.log("  bun run scripts/release-version.ts 0.8.0");
  process.exit(versionArg ? 0 : 1);
}

releaseVersion(versionArg).catch((err) => {
  console.error(`❌ Release failed: ${err.message}`);
  if (err.stack) console.error("\nStack trace:", err.stack);
  process.exit(1);
});

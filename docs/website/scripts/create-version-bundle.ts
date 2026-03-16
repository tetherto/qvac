#!/usr/bin/env bun
/**
 * Freeze the current (latest) docs as a versioned bundle.
 *
 * Run this BEFORE updating (latest) with new content. It snapshots the
 * current state of (latest) into a versioned folder so the outgoing
 * version remains accessible when a newer version takes over.
 *
 * Example: when releasing SDK v0.8.0, first freeze the outgoing v0.7.0:
 *   bun run scripts/create-version-bundle.ts 0.7.0
 * Then update (latest) with v0.8.0 content and versions.ts.
 *
 * Steps:
 *   1. Copies content/docs/(latest)/ to content/docs/v{version}/
 *   2. Rewrites all internal links in MDX files to add the version prefix
 *   3. Snapshots src/lib/trees/latest.ts to src/lib/trees/v{version}.ts
 *   4. Updates src/lib/trees/index.ts to import the new tree
 *   5. Refreshes src/lib/versions.ts
 *
 * Usage:
 *   bun run scripts/create-version-bundle.ts <outgoing-version>
 *
 * Examples:
 *   bun run scripts/create-version-bundle.ts 0.7.0   # freeze v0.7.0 before releasing v0.8.0
 *   bun run scripts/create-version-bundle.ts 0.6.1   # freeze v0.6.1 before releasing v0.7.0
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";

const INTERNAL_LINK_PATTERNS = [
  /href="(\/[^"]*?)"/g,
  /\]\((\/[^)]*?)\)/g,
];

function rewriteLinks(content: string, versionPrefix: string): string {
  let result = content;
  for (const pattern of INTERNAL_LINK_PATTERNS) {
    result = result.replace(pattern, (match, linkPath: string) => {
      if (linkPath.startsWith("/#")) return match;
      if (/^\/v\d+\.\d+\.\d+\//.test(linkPath)) return match;
      return match.replace(linkPath, `${versionPrefix}${linkPath}`);
    });
  }
  return result;
}

async function rewriteLinksInDir(dir: string, versionPrefix: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      count += await rewriteLinksInDir(fullPath, versionPrefix);
      continue;
    }

    if (!entry.name.endsWith(".mdx") && !entry.name.endsWith(".md")) continue;

    const content = await fs.readFile(fullPath, "utf-8");
    const rewritten = rewriteLinks(content, versionPrefix);

    if (rewritten !== content) {
      await fs.writeFile(fullPath, rewritten, "utf-8");
      count++;
    }
  }

  return count;
}

const TREE_URL_PATTERN = /url:\s*'(\/[^']*)'/g;

function rewriteTreeUrls(content: string, versionPrefix: string): string {
  return content.replace(TREE_URL_PATTERN, (match, urlPath: string) => {
    if (urlPath === '/') return match;
    if (urlPath.startsWith('/#')) return match;
    if (/^\/v\d+\.\d+\.\d+\//.test(urlPath)) return match;
    return match.replace(urlPath, `${versionPrefix}${urlPath}`);
  });
}

function rewriteTreeApiLookup(content: string, versionPrefix: string): string {
  return content.replace(
    /findFolderChildren\(source\.pageTree\.children,\s*'([^']*)'\)/g,
    (match, indexUrl: string) => {
      if (indexUrl.startsWith('/v')) return match;
      return match.replace(indexUrl, `${versionPrefix}${indexUrl}`);
    }
  );
}

async function snapshotTree(version: string, versionPrefix: string): Promise<void> {
  const treesDir = path.join(process.cwd(), "src", "lib", "trees");
  const latestTree = path.join(treesDir, "latest.ts");
  const versionTree = path.join(treesDir, `v${version}.ts`);

  let content = await fs.readFile(latestTree, "utf-8");
  content = rewriteTreeUrls(content, versionPrefix);
  content = rewriteTreeApiLookup(content, versionPrefix);
  await fs.writeFile(versionTree, content, "utf-8");
  console.log(`✓ Snapshotted tree: latest.ts → v${version}.ts`);
}

async function updateTreesIndex(version: string): Promise<void> {
  const indexPath = path.join(process.cwd(), "src", "lib", "trees", "index.ts");
  let content = await fs.readFile(indexPath, "utf-8");

  const safeVar = `v${version.replace(/\./g, "")}`;
  const importLine = `import { tree as ${safeVar}Tree } from './v${version}';`;

  if (content.includes(importLine)) {
    console.log(`✓ trees/index.ts already imports v${version}`);
    return;
  }

  content = content.replace(
    /(import { tree as latestTree }[^\n]*\n)/,
    `$1${importLine}\n`
  );

  content = content.replace(
    /return \{(\n\s*'latest': latestTree,)/,
    `return {\n    'v${version}': ${safeVar}Tree,$1`
  );

  await fs.writeFile(indexPath, content, "utf-8");
  console.log(`✓ Updated trees/index.ts with v${version}`);
}

async function createVersionBundle(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Invalid version format: "${version}"\nExpected semver: X.Y.Z (e.g., 0.8.0)`
    );
  }

  const docsDir = path.join(process.cwd(), "content", "docs");
  const latestDir = path.join(docsDir, "(latest)");
  const targetDir = path.join(docsDir, `v${version}`);
  const versionPrefix = `/v${version}`;

  const latestExists = await fs.stat(latestDir).then(() => true).catch(() => false);
  if (!latestExists) {
    throw new Error(`(latest) directory not found at ${latestDir}`);
  }

  const targetExists = await fs.stat(targetDir).then(() => true).catch(() => false);
  if (targetExists) {
    console.log(`⚠️  v${version} already exists. Removing and recreating...`);
    await fs.rm(targetDir, { recursive: true, force: true });
  }

  console.log(`📦 Creating version bundle v${version}...`);
  console.log(`   Source: ${latestDir}`);
  console.log(`   Target: ${targetDir}`);

  await fs.cp(latestDir, targetDir, { recursive: true });
  console.log(`✓ Copied (latest) → v${version}`);

  const rewrittenCount = await rewriteLinksInDir(targetDir, versionPrefix);
  console.log(`✓ Rewrote internal links in ${rewrittenCount} files`);

  await snapshotTree(version, versionPrefix);
  await updateTreesIndex(version);

  console.log(`📋 Updating versions list...`);
  execSync(`bun run scripts/update-versions-list.ts v${version}`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  console.log(`✅ Version bundle v${version} created successfully`);
}

// CLI
const args = process.argv.slice(2);
const versionArg = args[0];

if (!versionArg || args.includes("--help") || args.includes("-h")) {
  console.log("Usage: bun run scripts/create-version-bundle.ts <outgoing-version>");
  console.log("");
  console.log("Freezes the current (latest) docs as a versioned bundle.");
  console.log("Run BEFORE updating (latest) with the new SDK version content.");
  console.log("");
  console.log("Example workflow when releasing v0.8.0:");
  console.log("  1. bun run scripts/create-version-bundle.ts 0.7.0   # freeze outgoing");
  console.log("  2. Update (latest) with v0.8.0 content");
  console.log("  3. Update versions.ts to mark v0.8.0 as latest");
  process.exit(versionArg ? 0 : 1);
}

createVersionBundle(versionArg).catch((err) => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});

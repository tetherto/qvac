#!/usr/bin/env bun
/**
 * Generates a unified release-notes MDX page for a given version by reading
 * CHANGELOG.md from each SDK pod package, normalizing section headings, merging
 * entries across packages, and rendering through a Nunjucks template.
 *
 * Usage: bun run scripts/generate-release-notes.ts <version>
 * Example: bun run scripts/generate-release-notes.ts 0.8.1
 *
 * Expects to run from docs/website/ inside the monorepo.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import nunjucks from "nunjucks";
import {
  extractVersionBlock,
  parseVersionBlock,
  mergeChangelogs,
  parseOverridesContent,
  type PackageChangelog,
  type OverrideSection,
} from "./lib/changelog-parser";

const SDK_POD_PACKAGES = ["sdk", "cli", "rag", "logging", "error"] as const;

function parseChangelog(
  filePath: string,
  pkg: string,
  version: string
): PackageChangelog | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const block = extractVersionBlock(content, version);
  if (!block) return null;

  const { preamble, sections } = parseVersionBlock(block);
  return { pkg, preamble, sections };
}

function parseOverrides(filePath: string): OverrideSection[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return parseOverridesContent(content);
}

function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(
      "Usage: bun run scripts/generate-release-notes.ts <version>"
    );
    console.error("  version must be semver (e.g. 0.8.1)");
    process.exit(1);
  }

  const websiteDir = process.cwd();
  const repoRoot = resolve(websiteDir, "../..");

  console.log(`Generating release notes for v${version}...\n`);

  const changelogs: PackageChangelog[] = [];
  for (const pkg of SDK_POD_PACKAGES) {
    const changelogPath = resolve(
      repoRoot,
      "packages",
      pkg,
      "CHANGELOG.md"
    );
    const parsed = parseChangelog(changelogPath, pkg, version);
    if (parsed) {
      console.log(`  Found v${version} in @qvac/${pkg}`);
      changelogs.push(parsed);
    } else if (!existsSync(changelogPath)) {
      console.log(`  Skipping @qvac/${pkg} (no CHANGELOG.md)`);
    } else {
      console.log(`  Skipping @qvac/${pkg} (v${version} not found)`);
    }
  }

  if (changelogs.length === 0) {
    console.error(
      `\nNo changelog entries found for v${version} in any SDK pod package.`
    );
    process.exit(1);
  }

  const categories = mergeChangelogs(changelogs);

  const preambles = changelogs
    .filter((c) => c.preamble.length > 0)
    .map((c) => ({ pkg: c.pkg, content: c.preamble }));

  const overridesPath = resolve(
    websiteDir,
    "release-notes-overrides",
    `${version}.md`
  );
  const overrides = parseOverrides(overridesPath);
  if (overrides.length > 0) {
    console.log(
      `  Loaded ${overrides.length} override section(s) from ${version}.md`
    );
  }

  const templateDir = resolve(
    websiteDir,
    "scripts",
    "api-docs",
    "templates"
  );
  nunjucks.configure(templateDir, {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  });

  const rendered = nunjucks.render("release-notes-page.njk", {
    version,
    categories,
    preambles,
    overrides,
    generatedDate: new Date().toISOString().split("T")[0],
  });

  const outputPath = resolve(
    websiteDir,
    "content",
    "docs",
    "(latest)",
    "release-notes.mdx"
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered.trim() + "\n", "utf-8");

  console.log(`\nWrote ${outputPath}`);
  console.log(
    `  ${categories.length} category(s) from ${changelogs.length} package(s)`
  );
}

main();

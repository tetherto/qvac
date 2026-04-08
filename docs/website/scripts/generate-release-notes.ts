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

const SDK_POD_PACKAGES = ["sdk", "cli", "rag", "logging", "error"] as const;

const CATEGORY_MAP: Record<string, string> = {
  "breaking changes": "Breaking Changes",
  "new apis": "Features",
  "api": "API",
  "api changes": "API",
  "bug fixes": "Bug Fixes",
  "fixes": "Bug Fixes",
  "fixed": "Bug Fixes",
  "models": "Models",
  "documentation": "Documentation",
  "docs": "Documentation",
  "testing": "Testing",
  "tests": "Testing",
  "chores": "Chores",
  "infrastructure": "Infrastructure",
  "changed": "Changed",
  "added": "Added",
  "features": "Features",
  "removed": "Removed",
  "deprecated": "Deprecated",
  "security": "Security",
};

const CATEGORY_ORDER = [
  "Breaking Changes",
  "Features",
  "API",
  "Changed",
  "Added",
  "Bug Fixes",
  "Models",
  "Documentation",
  "Testing",
  "Chores",
  "Infrastructure",
  "Removed",
  "Deprecated",
  "Security",
];

interface ParsedSection {
  category: string;
  content: string;
}

interface PackageChangelog {
  pkg: string;
  preamble: string;
  sections: ParsedSection[];
}

interface MergedCategory {
  name: string;
  packages: Array<{ pkg: string; content: string }>;
}

interface OverrideSection {
  heading: string;
  content: string;
}

function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0E\uFE0F]/gu, "")
    .trim();
}

function normalizeCategory(heading: string): string {
  const stripped = stripEmoji(heading);
  const lower = stripped.toLowerCase();
  return CATEGORY_MAP[lower] ?? stripped;
}

function isKnownCategory(heading: string): boolean {
  const stripped = stripEmoji(heading);
  return stripped.toLowerCase() in CATEGORY_MAP;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractVersionBlock(
  content: string,
  version: string
): string | null {
  const pattern = new RegExp(
    `^## \\[${escapeRegExp(version)}\\].*$`,
    "m"
  );
  const match = pattern.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextVersion = /^## \[/m.exec(rest);
  const block = nextVersion ? rest.slice(0, nextVersion.index) : rest;

  return block.trim();
}

function parseVersionBlock(block: string): {
  preamble: string;
  sections: ParsedSection[];
} {
  const lines = block.split("\n");
  const sections: ParsedSection[] = [];
  let preamble = "";
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const sectionRe = /^#{2,3}\s+(.+)$/;

  function flush() {
    if (currentHeading === null) return;
    const content = currentLines.join("\n").trim();
    if (content) {
      sections.push({ category: normalizeCategory(currentHeading), content });
    }
  }

  for (const line of lines) {
    const headingMatch = sectionRe.exec(line);
    if (headingMatch) {
      const text = headingMatch[1].trim();
      if (/^\[?\d+\.\d+/.test(text)) continue;

      if (isKnownCategory(text)) {
        flush();
        currentHeading = text;
        currentLines = [];
      } else if (currentHeading !== null) {
        currentLines.push(line);
      } else {
        preamble += line + "\n";
      }
    } else if (currentHeading !== null) {
      currentLines.push(line);
    } else {
      preamble += line + "\n";
    }
  }

  flush();

  preamble = preamble.replace(/^---\s*$/gm, "").trim();

  for (const section of sections) {
    section.content = section.content.replace(/\n---\s*$/g, "").trim();
  }

  return { preamble, sections };
}

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

function mergeChangelogs(changelogs: PackageChangelog[]): MergedCategory[] {
  const map = new Map<string, Array<{ pkg: string; content: string }>>();

  for (const cl of changelogs) {
    for (const section of cl.sections) {
      if (!map.has(section.category)) {
        map.set(section.category, []);
      }
      map.get(section.category)!.push({
        pkg: cl.pkg,
        content: section.content,
      });
    }
  }

  const ordered: MergedCategory[] = [];
  for (const name of CATEGORY_ORDER) {
    const pkgs = map.get(name);
    if (pkgs && pkgs.length > 0) {
      ordered.push({ name, packages: pkgs });
      map.delete(name);
    }
  }

  const remaining = [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  for (const [name, pkgs] of remaining) {
    if (pkgs.length > 0) {
      ordered.push({ name, packages: pkgs });
    }
  }

  return ordered;
}

function parseOverrides(filePath: string): OverrideSection[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const sections: OverrideSection[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const headingRe = /^##\s+(.+)$/;

  function flush() {
    if (heading === null) return;
    const trimmed = buffer.join("\n").trim();
    if (trimmed) {
      sections.push({ heading, content: trimmed });
    }
  }

  for (const line of lines) {
    const match = headingRe.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
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

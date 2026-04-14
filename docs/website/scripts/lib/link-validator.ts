/**
 * Cross-version link validation. Extracts internal links from MDX files
 * and resolves them to filesystem paths, reporting any broken references.
 *
 * Used both as a post-step in create-version-bundle.ts and as a standalone
 * Vitest test for (latest).
 */

import * as fs from "fs/promises";
import * as path from "path";

const INTERNAL_LINK_PATTERNS = [
  /href="(\/[^"]*?)"/g,
  /\]\((\/[^)]*?)\)/g,
];

export interface BrokenLink {
  source: string;
  target: string;
}

/**
 * Extract all internal link paths from MDX/MD content.
 * Returns de-duplicated absolute paths (starting with /).
 */
export function extractInternalLinks(content: string): string[] {
  const links = new Set<string>();
  for (const pattern of INTERNAL_LINK_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      let linkPath = match[1];
      const hashIdx = linkPath.indexOf("#");
      if (hashIdx !== -1) linkPath = linkPath.slice(0, hashIdx);
      if (linkPath.length > 0) links.add(linkPath);
    }
  }
  return [...links];
}

/**
 * Resolve an internal link path to a filesystem path.
 * Handles the Fumadocs (latest) folder convention: unversioned paths
 * (e.g. /sdk/api/loadModel) resolve into (latest)/, while versioned
 * paths (e.g. /v0.7.0/sdk/api/loadModel) resolve directly.
 */
async function resolveLink(linkPath: string, docsBase: string): Promise<boolean> {
  const cleaned = linkPath.replace(/\/$/, "");

  const isVersioned = /^\/v\d+\.\d+\.\d+\//.test(cleaned);
  const fsPrefixes = isVersioned
    ? [cleaned]
    : [cleaned, path.join("(latest)", cleaned)];

  for (const prefix of fsPrefixes) {
    const fsPath = path.join(docsBase, prefix);
    const candidates = [
      `${fsPath}.mdx`,
      `${fsPath}.md`,
      path.join(fsPath, "index.mdx"),
      path.join(fsPath, "index.md"),
      fsPath,
    ];

    for (const candidate of candidates) {
      try {
        await fs.stat(candidate);
        return true;
      } catch {
        // not found, try next
      }
    }
  }
  return false;
}

/**
 * Recursively collect all .mdx / .md files in a directory.
 */
async function collectMdxFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectMdxFiles(fullPath));
    } else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Validate all internal links in MDX files under `targetDir`.
 * `docsBase` is the root content directory (e.g. content/docs/).
 *
 * Returns an array of broken links with source file and target path.
 */
export async function validateLinks(
  targetDir: string,
  docsBase: string,
): Promise<BrokenLink[]> {
  const files = await collectMdxFiles(targetDir);
  const broken: BrokenLink[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const links = extractInternalLinks(content);

    for (const linkPath of links) {
      const resolved = await resolveLink(linkPath, docsBase);
      if (!resolved) {
        broken.push({
          source: path.relative(docsBase, file),
          target: linkPath,
        });
      }
    }
  }

  return broken;
}

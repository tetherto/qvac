/**
 * Internal link validation for the docs site. Extracts internal links
 * from MDX files and resolves them to filesystem paths, reporting any
 * broken references. Used by `tests/link-integrity.test.ts`.
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
 * Build a Set of all file paths under a directory (relative to that directory,
 * normalized with forward slashes). Collected once and used for O(1) lookups
 * instead of per-link fs.stat calls.
 */
async function buildFileIndex(dir: string): Promise<Set<string>> {
  const index = new Set<string>();
  const entries = await fs.readdir(dir, { recursive: true });
  for (const entry of entries) {
    index.add(entry.replace(/\\/g, "/"));
  }
  return index;
}

/**
 * Resolve an internal link path against the pre-built file index.
 *
 * Every URL maps to a bare path under `content/docs/`. A link to
 * `/sdk/api/v0.8.0` resolves to either `sdk/api/v0.8.0.mdx` or
 * `sdk/api/v0.8.0/index.mdx`.
 */
function resolveLink(linkPath: string, fileIndex: Set<string>): boolean {
  const cleaned = linkPath.replace(/\/$/, "").replace(/^\//, "");
  const candidates = [
    `${cleaned}.mdx`,
    `${cleaned}.md`,
    `${cleaned}/index.mdx`,
    `${cleaned}/index.md`,
    cleaned,
  ];
  for (const candidate of candidates) {
    if (fileIndex.has(candidate)) return true;
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
  const [files, fileIndex] = await Promise.all([
    collectMdxFiles(targetDir),
    buildFileIndex(docsBase),
  ]);
  const broken: BrokenLink[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const links = extractInternalLinks(content);

    for (const linkPath of links) {
      if (!resolveLink(linkPath, fileIndex)) {
        broken.push({
          source: path.relative(docsBase, file),
          target: linkPath,
        });
      }
    }
  }

  return broken;
}

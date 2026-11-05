/**
 * Internal link validation for the docs site. Extracts internal links
 * from MDX files and resolves them to filesystem paths, reporting any
 * broken references. Used by `tests/link-integrity.test.ts`.
 *
 * Links are authored version-less, so a link into a versioned collection
 * names no folder and has to be resolved against a documentation line — the
 * same resolution the build performs. A link is checked in the line it will
 * actually point at once built: the reader's own line for a same-collection
 * link, and the current line for a link arriving from anywhere else.
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  DOCUMENTED_SOFTWARE,
  getCurrentLine,
  getDocumentedSoftware,
} from "../../src/lib/versions.js";
import { stripMdxComments } from "../../src/lib/mdx-comments.js";

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
  const visible = stripMdxComments(content);
  for (const pattern of INTERNAL_LINK_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(visible)) !== null) {
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
 * The content paths a link may resolve from: the link with a line folder
 * spliced in, and the link as written.
 *
 * The line is the one the built link will carry — the line of the page
 * holding the link when it points at that page's own collection, the current
 * line otherwise. A link naming a version explicitly is left as written.
 *
 * The literal path stays a candidate for a collection the manifest already
 * declares versioned but whose content has not been cut into lines yet, where
 * the literal path is the true one. It cannot mask a break in a collection
 * that has been cut, because a cut leaves nothing directly under the
 * collection for it to find.
 *
 * `sourcePath` is the source file's path under `content/docs`.
 */
export function contentPathsOfLink(
  linkPath: string,
  sourcePath: string,
): string[] {
  const cleaned = linkPath.replace(/\/$/, "").replace(/^\//, "");
  const [collection, ...rest] = cleaned.split("/");

  const software = getDocumentedSoftware(`/${collection}`);
  if (!software || software.kind !== "collection") return [cleaned];
  if (software.versions.some((entry) => entry.version === rest[0])) {
    return [cleaned];
  }

  const [sourceCollection, sourceFolder] = sourcePath.split("/");
  const readersLine =
    sourceCollection === collection
      ? software.versions.find((entry) => entry.folder === sourceFolder)
      : undefined;
  const line = readersLine ?? getCurrentLine(software);
  if (!line) return [cleaned];

  return [[collection, line.folder, ...rest].join("/"), cleaned];
}

/**
 * Resolve an internal link path against the pre-built file index.
 *
 * A link to `/sdk/quickstart` from a page in `v0.16` resolves to
 * `sdk/v0.16/quickstart.mdx`; the same link from an Ecosystem page resolves to
 * the current line's copy.
 */
function resolveLink(
  linkPath: string,
  sourcePath: string,
  fileIndex: Set<string>,
): boolean {
  return contentPathsOfLink(linkPath, sourcePath).some((contentPath) =>
    hasPage(fileIndex, contentPath),
  );
}

/**
 * `true` when a content path names a page present in the index.
 *
 * The empty path is the index of the tree itself, which is what a link to a
 * collection's root resolves to once the collection segment is dropped.
 */
function hasPage(index: Set<string>, contentPath: string): boolean {
  const candidates =
    contentPath === ""
      ? ["index.mdx", "index.md"]
      : [
          `${contentPath}.mdx`,
          `${contentPath}.md`,
          `${contentPath}/index.mdx`,
          `${contentPath}/index.md`,
          contentPath,
        ];
  return candidates.some((candidate) => index.has(candidate));
}

/**
 * Validate the internal links of a collection's development line.
 *
 * The line sits outside `content/docs/`, so the build never renders it and
 * nothing reports a break in it until the cutoff copies it into the
 * collection — on the one PR of the release that cannot wait. This is what
 * moves that report back onto the PR that wrote the link.
 *
 * Resolution treats the line as the line it is about to become: a
 * same-collection link resolves inside it, because the page it points at was
 * written in the same sprint and will be published alongside it; a link naming
 * a version, or naming another collection, resolves against the docs tree the
 * way a published page's would.
 */
export async function validateDevelopmentLine(
  slug: string,
  lineDir: string,
  docsBase: string,
): Promise<BrokenLink[]> {
  const [files, lineIndex, docsIndex] = await Promise.all([
    collectMdxFiles(lineDir),
    buildFileIndex(lineDir),
    buildFileIndex(docsBase),
  ]);
  const versions = getDocumentedSoftware(`/${slug}`)?.versions ?? [];
  const broken: BrokenLink[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const source = path.relative(lineDir, file).replaceAll("\\", "/");

    for (const linkPath of extractInternalLinks(content)) {
      const cleaned = linkPath.replace(/\/$/, "").replace(/^\//, "");
      const [collection, ...rest] = cleaned.split("/");
      const named = versions.some((entry) => entry.version === rest[0]);

      // The line's own pages are indexed from the line's root, so the
      // collection segment the published path carries is dropped here.
      const resolved =
        collection === slug && !named
          ? hasPage(lineIndex, rest.join("/"))
          : // Prefixed with the collection so the reader counts as outside
            // every other one, which is how a cross-collection link resolves.
            resolveLink(linkPath, `${slug}/${source}`, docsIndex);

      if (!resolved) broken.push({ source, target: linkPath });
    }
  }

  return broken;
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
    const source = path.relative(docsBase, file).replaceAll("\\", "/");

    for (const linkPath of links) {
      if (!resolveLink(linkPath, source, fileIndex)) {
        broken.push({ source, target: linkPath });
      }
    }
  }

  return broken;
}

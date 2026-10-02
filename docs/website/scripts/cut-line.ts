#!/usr/bin/env bun
/**
 * Cut a versioned collection's next documentation line.
 *
 * A line is a folder under its collection holding a complete page tree. The
 * current line's folder is parenthesized, a Fumadocs group excluded from the
 * slug, so its pages answer at the version-less paths; every other line's
 * folder is plain, so its pages carry the version. Cutting is therefore two
 * moves — the outgoing group becomes plain, and a copy of it becomes the new
 * group — plus the edits that keep the rest of the site agreeing with them.
 *
 * This does exactly what the hand procedure in `README.md` does, in one
 * command. It is a convenience and never a dependency: a cut made by hand is
 * the same cut, and the build is what accepts either. Nothing in the release
 * flow calls this — the documentation engineer runs it, reviews the diff, and
 * opens a PR.
 *
 * It does not build. The checks that reject a malformed cut already exist, and
 * reporting success of its own would be a second opinion that could disagree
 * with them.
 *
 * Usage:
 *   bun run scripts/cut-line.ts <collection> <version>
 *
 *   bun run scripts/cut-line.ts sdk v0.21
 *   bun run scripts/cut-line.ts cli 0.15
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "node:url";
import { DOCUMENTED_SOFTWARE } from "../src/lib/versions.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");

/** How far each column of a `_redirects` rule is indented, in characters. */
const REDIRECT_COLUMNS = { source: 19, destination: 29 };

export interface CutRequest {
  /** Root to operate under. The real site, or a copy of it under test. */
  root: string;
  /** The collection's slug, as its path's single segment: `sdk`, `cli`. */
  slug: string;
  /** The line to open, `vX.Y`. */
  version: string;
}

export interface CutResult {
  preserved: string;
  opened: string;
  /** Paths changed, relative to the root, in the order they were touched. */
  changed: string[];
}

/**
 * A line name: major and minor, never a patch. Accepts a leading `v` or not,
 * and refuses a patch component — a line represents every patch in its range,
 * so `v0.21.0` names a release, not a line.
 */
function parseLine(version: string): { major: number; minor: number } {
  const trimmed = version.replace(/^v/, "");
  const match = /^(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `"${version}" does not name a line. A line is major and minor, with no ` +
        `patch: v0.21, not v0.21.0.`,
    );
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** `true` when `a` is strictly above `b`. */
function isAbove(
  a: { major: number; minor: number },
  b: { major: number; minor: number },
): boolean {
  return a.major !== b.major ? a.major > b.major : a.minor > b.minor;
}

/**
 * Rewrite one collection's entry in the manifest: its current line's folder
 * loses the parentheses, and the line being opened is inserted above it.
 *
 * The edit is scoped to the entry's own `versions` array — located by the
 * collection's `path`, which is unique across the manifest — so a collection
 * that happens to share a version number with another is never touched.
 */
export function cutManifest(
  source: string,
  collectionPath: string,
  preserved: string,
  opened: string,
): string {
  const anchor = `    path: '${collectionPath}',\n    versions: [\n`;
  const start = source.indexOf(anchor);
  if (start === -1) {
    throw new Error(
      `The manifest has no entry at '${collectionPath}' in the expected shape.`,
    );
  }
  const from = start + anchor.length;
  const end = source.indexOf("    ],\n", from);
  const block = source.slice(from, end);

  const currentEntry = `      { version: '${preserved}', folder: '(${preserved})' },\n`;
  if (!block.includes(currentEntry)) {
    throw new Error(
      `'${collectionPath}' does not declare ${preserved} as its current line.`,
    );
  }

  const cut = block.replace(
    currentEntry,
    `      { version: '${opened}', folder: '(${opened})' },\n` +
      `      { version: '${preserved}', folder: '${preserved}' },\n`,
  );
  return source.slice(0, from) + cut + source.slice(end);
}

/**
 * Add the preserved line's index pair to the redirects.
 *
 * Every line whose folder is plain needs it: the last segment carries a dot,
 * so the CDN reads the URL as a file request and never normalizes the trailing
 * slash. The pair goes at the head of its collection's existing pairs, keeping
 * the block ordered newest first, which is the order a reader of the diff
 * expects.
 */
export function cutRedirects(source: string, slug: string, preserved: string): string {
  const rule = (from: string, to: string, status: string) =>
    from.padEnd(REDIRECT_COLUMNS.source) +
    to.padEnd(REDIRECT_COLUMNS.destination) +
    status;

  const pair = [
    rule(`/${slug}/${preserved}/`, `/${slug}/${preserved}/index.html`, "200"),
    rule(`/${slug}/${preserved}`, `/${slug}/${preserved}/`, "301"),
  ];

  const lines = source.split("\n");
  const isIndexRule = (line: string) =>
    /^\/\w[\w-]*\/v[\d.]+\/?\s+\/\w[\w-]*\/v[\d.]+/.test(line);

  let at = lines.findIndex(
    (line) => line.startsWith(`/${slug}/v`) && isIndexRule(line),
  );
  if (at === -1) {
    // First cut for this collection: sit below the block rather than inside
    // another collection's run of pairs.
    const last = lines.reduce(
      (found, line, index) => (isIndexRule(line) ? index : found),
      -1,
    );
    if (last === -1) {
      throw new Error(
        "`public/_redirects` carries no line index rules, so there is no " +
          "block to add this one to.",
      );
    }
    at = last + 1;
  }

  if (lines.some((line) => line.startsWith(`/${slug}/${preserved}/ `))) {
    throw new Error(`\`public/_redirects\` already carries /${slug}/${preserved}.`);
  }

  lines.splice(at, 0, ...pair);
  return lines.join("\n");
}

/**
 * Move a page's currency marker from one line to another.
 *
 * A page states in its own title which series it documents and whether that
 * series is current — `API Summary — v0.20.x (latest)`. Currency is a property
 * of which folder is parenthesized, and a cut is the only thing that changes
 * it, so a cut is what maintains the claim. Returns `null` when the title says
 * nothing about the series, which is most pages.
 */
export function relabelTitle(
  source: string,
  from: string,
  to: string | null,
): string | null {
  const series = (line: string) => `v${line.replace(/^v/, "")}.x`;
  const marker = new RegExp(
    `^(title:.*)${series(from).replace(/\./g, "\\.")}( \\(latest\\))?`,
    "m",
  );
  const match = marker.exec(source);
  if (!match) return null;

  return source.replace(
    marker,
    to === null ? `$1${series(from)}` : `$1${series(to)} (latest)`,
  );
}

/** Every `.mdx` under `dir`, recursively. */
async function pagesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return pagesUnder(full);
      return entry.name.endsWith(".mdx") ? [full] : [];
    }),
  );
  return found.flat();
}

/**
 * Relabel every page of one line, best-effort: a collection's pages are not
 * all shaped alike — the CLI publishes no API summary — so a line with no
 * marker anywhere is a valid line, not a failure.
 */
async function relabelLine(
  dir: string,
  from: string,
  to: string | null,
): Promise<string[]> {
  const touched: string[] = [];
  for (const page of await pagesUnder(dir)) {
    const relabelled = relabelTitle(await fs.readFile(page, "utf-8"), from, to);
    if (relabelled === null) continue;
    await fs.writeFile(page, relabelled);
    touched.push(page);
  }
  return touched;
}

/** Perform the cut. Every refusal happens before the first write. */
export async function cutLine(request: CutRequest): Promise<CutResult> {
  const { root, slug } = request;
  const collectionPath = `/${slug}`;

  const software = DOCUMENTED_SOFTWARE.find(
    (entry) => entry.path === collectionPath && entry.kind === "collection",
  );
  if (!software) {
    const versioned = DOCUMENTED_SOFTWARE.filter(
      (entry) => entry.kind === "collection",
    ).map((entry) => entry.path.slice(1));
    throw new Error(
      `'${slug}' is not a versioned collection. Cuttable: ${versioned.join(", ")}.`,
    );
  }

  const current = software.versions.find((entry) =>
    entry.folder.startsWith("("),
  );
  if (!current) {
    throw new Error(
      `'${slug}' declares no current line, so there is nothing to cut from.`,
    );
  }

  const line = parseLine(request.version);
  const opened = `v${line.major}.${line.minor}`;
  if (!isAbove(line, parseLine(current.version))) {
    throw new Error(
      `${opened} is not above ${current.version}, the current line of ` +
        `'${slug}'. A cut opens the line that comes next.`,
    );
  }

  const collectionDir = path.join(root, "content", "docs", slug);
  const outgoing = path.join(collectionDir, `(${current.version})`);
  const preserved = path.join(collectionDir, current.version);
  const openedDir = path.join(collectionDir, `(${opened})`);

  for (const occupied of [preserved, openedDir]) {
    if (await exists(occupied)) {
      throw new Error(
        `${path.relative(root, occupied)} already exists. A cut writes two new ` +
          `folders and overwrites neither.`,
      );
    }
  }

  const manifestPath = path.join(root, "src", "lib", "versions.ts");
  const redirectsPath = path.join(root, "public", "_redirects");
  const manifest = cutManifest(
    await fs.readFile(manifestPath, "utf-8"),
    collectionPath,
    current.version,
    opened,
  );
  const redirects = cutRedirects(
    await fs.readFile(redirectsPath, "utf-8"),
    slug,
    current.version,
  );

  // Every refusal is behind us; from here the cut is applied.
  await fs.rename(outgoing, preserved);
  await fs.cp(preserved, openedDir, { recursive: true });
  await fs.writeFile(manifestPath, manifest);
  await fs.writeFile(redirectsPath, redirects);

  const relabelled = [
    ...(await relabelLine(preserved, current.version, null)),
    ...(await relabelLine(openedDir, current.version, opened)),
  ];

  return {
    preserved: current.version,
    opened,
    changed: [
      path.relative(root, preserved),
      path.relative(root, openedDir),
      path.relative(root, manifestPath),
      path.relative(root, redirectsPath),
      ...relabelled.map((page) => path.relative(root, page)),
    ],
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse a cut made on top of other work. The cut is reviewed as a diff, and a
 * diff carrying unrelated edits is not one an operator can check.
 */
function refuseDirtyTree(root: string): void {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", root], {
    encoding: "utf-8",
  }).trim();
  if (dirty) {
    throw new Error(
      "The working tree under docs/website already carries changes. A cut is " +
        "reviewed as its own diff — commit or stash first.\n" +
        dirty
          .split("\n")
          .slice(0, 10)
          .map((line) => `  ${line}`)
          .join("\n"),
    );
  }
}

if (import.meta.main) {
  const [slug, version, ...rest] = process.argv.slice(2);
  if (!slug || !version || rest.length > 0) {
    console.log("Usage: bun run scripts/cut-line.ts <collection> <version>");
    console.log("");
    console.log("  bun run scripts/cut-line.ts sdk v0.21");
    console.log("");
    console.log("Cuts the collection's next documentation line: preserves the");
    console.log("current one, opens the new one as a copy, and updates the");
    console.log("manifest, the redirects, and the currency marker.");
    process.exit(slug && version ? 1 : 0);
  }

  try {
    refuseDirtyTree(DOCS_WEBSITE_DIR);
    const result = await cutLine({ root: DOCS_WEBSITE_DIR, slug, version });
    console.log(`Cut ${slug}: ${result.preserved} preserved, ${result.opened} opened.`);
    for (const change of result.changed) console.log(`  ${change}`);
    console.log("");
    console.log("Review the diff, then `npm run build` and `npm test`.");
  } catch (error) {
    console.error(`Cut refused: ${(error as Error).message}`);
    process.exit(1);
  }
}

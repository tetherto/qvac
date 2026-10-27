#!/usr/bin/env bun
/**
 * Cut a versioned collection's documentation line for the version being
 * released.
 *
 * A line is a folder holding a complete page tree. Every line that has been
 * cut lives under `content/docs/<collection>/`: the newest one is
 * parenthesized, a Fumadocs group excluded from the slug, so its pages answer
 * at the version-less paths, and every older one is plain, so its pages carry
 * the version. The line still being written lives outside the site, at
 * `content/_unpublished/<collection>/next/`, where nothing builds it and no URL
 * reaches it.
 *
 * A cut is therefore: the outgoing group becomes plain, a copy of the
 * development line becomes the new group, and the development line stays where
 * it is — it is already the next version's. The development line is neither
 * renamed nor deleted, so git has no deletion to pair a pre-cutoff edit
 * against and cannot replay a feature PR's work into a version it was not
 * written for. That is the whole reason the line is addressed by a fixed name
 * instead of by its number.
 *
 * The outgoing group is renamed, though, and the new group is byte-identical
 * to it wherever the sprint changed nothing. A PR that edits the group and
 * merges after the cut therefore has two exact rename candidates per page, and
 * git picks one (QVAC-27286). The `Documentation lines` job in
 * `.github/workflows/docs-website-pr-checks.yml` fails such a PR until it is
 * rebased — it is not a required check, so it makes the window visible rather
 * than withholding the merge; a fixed group folder name would remove the
 * rename altogether, and is the structural answer this model has not taken.
 *
 * This does exactly what the hand procedure in `README.md` does, in one
 * command. It is a convenience and never a dependency: a cut made by hand is
 * the same cut, and the build is what accepts either.
 *
 * It does not build. The checks that reject a malformed cut already exist, and
 * reporting success of its own would be a second opinion that could disagree
 * with them.
 *
 * Usage:
 *   bun run scripts/cut-line.ts <collection> <version being released>
 *
 *   bun run scripts/cut-line.ts sdk v0.24
 *   bun run scripts/cut-line.ts cli 0.18
 */

import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "node:url";
import { DOCUMENTED_SOFTWARE } from "../src/lib/versions.js";
import { developmentLineDir } from "./lib/release-shared.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_WEBSITE_DIR = path.resolve(SCRIPT_DIR, "..");

/** How far each column of a `_redirects` rule is indented, in characters. */
const REDIRECT_COLUMNS = { source: 19, destination: 29 };

export interface CutRequest {
  /** Root to operate under. The real site, or a copy of it under test. */
  root: string;
  /** The collection's slug, as its path's single segment: `sdk`, `cli`. */
  slug: string;
  /** The version being released, `vX.Y`. Its line is the one the cut opens. */
  version: string;
}

export interface CutResult {
  /** The version released, whose line the cut published. */
  released: string;
  /** The line that lost the group. */
  preserved: string;
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

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * Add the preserved line's rules to the redirects.
 *
 * Every line whose folder is plain needs them, because every URL of it carries
 * a dot and the CDN never normalizes the trailing slash of a dotted path. The
 * index pair serves the root, whose dot in the last segment also costs it the
 * directory resolution. The splat serves each page below it addressed without
 * the slash: on a bare dotted path, it is the only rule form the CDN matches.
 * The rules go at the head of their collection's existing ones, keeping the
 * block ordered newest first, which is the order a reader of the diff expects.
 */
export function cutRedirects(source: string, slug: string, preserved: string): string {
  const rule = (from: string, to: string, status: string) =>
    from.padEnd(REDIRECT_COLUMNS.source) +
    to.padEnd(REDIRECT_COLUMNS.destination) +
    status;

  const line = `/${slug}/${preserved}`;
  const rules = [
    rule(`${line}/`, `${line}/index.html`, "200"),
    rule(line, `${line}/`, "301"),
    rule(`${line}/*`, `${line}/:splat/index.html`, "200"),
  ];

  const lines = source.split("\n");
  const isLineRule = (text: string) =>
    /^\/\w[\w-]*\/v[\d.]+(\/\*?)?\s+\/\w[\w-]*\/v[\d.]+/.test(text);

  let at = lines.findIndex(
    (text) => text.startsWith(`/${slug}/v`) && isLineRule(text),
  );
  if (at === -1) {
    // First cut for this collection: sit below the block rather than inside
    // another collection's run of rules.
    const last = lines.reduce(
      (found, text, index) => (isLineRule(text) ? index : found),
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

  if (lines.some((text) => text.startsWith(`${line}/ `))) {
    throw new Error(`\`public/_redirects\` already carries ${line}.`);
  }

  lines.splice(at, 0, ...rules);
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

/**
 * Point a line's release-notes sidebar entry at its own GitHub release.
 *
 * The site publishes no release-notes page: `reference/meta.json` carries an
 * external entry naming the tag of that line's first release
 * (`sdk-v0.22.0`). The URL is per line, and the development line is a copy of
 * the line cut before it, so without this the line being opened would inherit
 * the previous tag and advertise the wrong release — silently, since an
 * external entry is never checked against the content tree.
 *
 * The tag does not exist yet when the cut runs; it is created when the version
 * publishes, days later, which is also when production starts serving the
 * line. Pointing at it early is therefore correct, not broken.
 *
 * Returns `null` when the file carries no such entry, which is every
 * collection but the SDK.
 */
export function retargetReleaseNotesLink(
  source: string,
  slug: string,
  to: string,
): string | null {
  const entry = new RegExp(
    `(external:\\[[^\\]]*\\]\\([^)]*/releases/tag/)` +
      `${escapeForRegExp(slug)}-v[0-9]+\\.[0-9]+\\.0(\\))`,
  );
  if (!entry.test(source)) return null;
  return source.replace(
    entry,
    (_match, before: string, after: string) =>
      `${before}${slug}-${to}.0${after}`,
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

/**
 * Retarget a line's release-notes link, best-effort: only a collection whose
 * releases are published on GitHub carries the entry, so a line without it is
 * a valid line. Today that is the SDK; the CLI publishes no reference pages
 * and has no GitHub releases.
 */
async function retargetLineReleaseNotesLink(
  dir: string,
  slug: string,
  opened: string,
): Promise<string[]> {
  const meta = path.join(dir, "reference", "meta.json");
  if (!(await exists(meta))) return [];

  const retargeted = retargetReleaseNotesLink(
    await fs.readFile(meta, "utf-8"),
    slug,
    opened,
  );
  if (retargeted === null) return [];

  await fs.writeFile(meta, retargeted);
  return [meta];
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
  const released = `v${line.major}.${line.minor}`;
  const collectionDir = path.join(root, "content", "docs", slug);
  const development = developmentLineDir(slug, root);
  const hasDevelopmentLine = await exists(development);

  if (!isAbove(line, parseLine(current.version))) {
    throw new Error(
      `${released} is not above ${current.version}, the line '${slug}' last ` +
        `cut. A cut opens the line of the version that comes next.`,
    );
  }

  if (!hasDevelopmentLine) {
    throw new Error(
      `'${slug}' has no development line at ` +
        `${path.relative(root, development)}, so there is nothing to publish ` +
        `as ${released}. Cut ${current.version} first: that is what creates it.`,
    );
  }

  const outgoing = path.join(collectionDir, `(${current.version})`);
  const preserved = path.join(collectionDir, current.version);
  const openedDir = path.join(collectionDir, `(${released})`);

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
    released,
  );
  const redirects = cutRedirects(
    await fs.readFile(redirectsPath, "utf-8"),
    slug,
    current.version,
  );

  // Every refusal is behind us; from here the cut is applied.
  await fs.rename(outgoing, preserved);

  // The development line carries the outgoing line's markers, because that is
  // what it was copied from. Relabel and retarget it before the copy, so the
  // line being opened and the line still being written both come out naming
  // the version released — and the next cut has the same invariant to work
  // from.
  const relabelledDevelopment = await relabelLine(
    development,
    current.version,
    released,
  );
  const retargeted = await retargetLineReleaseNotesLink(
    development,
    slug,
    released,
  );
  await fs.cp(development, openedDir, { recursive: true });

  await fs.writeFile(manifestPath, manifest);
  await fs.writeFile(redirectsPath, redirects);

  const relabelled = [
    ...(await relabelLine(preserved, current.version, null)),
    ...relabelledDevelopment,
  ];

  const touched = [...relabelled, ...retargeted].map((page) =>
    path.relative(root, page),
  );

  return {
    released,
    preserved: current.version,
    changed: [
      path.relative(root, preserved),
      path.relative(root, openedDir),
      path.relative(root, manifestPath),
      path.relative(root, redirectsPath),
      ...new Set(touched),
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
    console.log(
      "Usage: bun run scripts/cut-line.ts <collection> <version being released>",
    );
    console.log("");
    console.log("  bun run scripts/cut-line.ts sdk v0.24");
    console.log("");
    console.log("Cuts the line of the version being released: preserves the");
    console.log("line cut before it, opens this one as a copy of the");
    console.log("development line, and updates the manifest, the redirects and");
    console.log("the currency marker. The development line stays where it is.");
    process.exit(slug && version ? 1 : 0);
  }

  try {
    refuseDirtyTree(DOCS_WEBSITE_DIR);
    const result = await cutLine({ root: DOCS_WEBSITE_DIR, slug, version });
    console.log(
      `Cut ${slug}: ${result.released} opened, ${result.preserved} preserved.`,
    );
    for (const change of result.changed) console.log(`  ${change}`);
    console.log("");
    console.log("Review the diff, then `npm run build` and `npm test`.");
  } catch (error) {
    console.error(`Cut refused: ${(error as Error).message}`);
    process.exit(1);
  }
}

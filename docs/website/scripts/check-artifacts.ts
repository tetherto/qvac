#!/usr/bin/env bun
/**
 * Checks the agent artifacts of the built site: the `llms.txt` hierarchy, the
 * per-line corpora, each collection's `versions.json`, and the per-page
 * Markdown.
 *
 * Four properties, all of which break silently:
 *
 *   - **Completeness** — every published line has an index and a corpus, and
 *     every page has a Markdown twin. A line whose artifacts were never
 *     generated is invisible: the site renders, and an agent simply never
 *     finds that release.
 *   - **Isolation** — no line-scoped artifact references another line of a
 *     versioned collection. Unversioned pages are free, and another versioned
 *     collection may be referenced at its current line. Cross-line leakage is
 *     what the lines exist to prevent, and it arrives by ordinary editing: a
 *     paragraph copied from one line into another keeps the paths it named.
 *   - **Resolution** — every URL an artifact lists exists in the build.
 *     `@vahor/next-broken-links` globs HTML and sitemaps and pulls links out
 *     of `<a href>`; it never opens a `.txt`, a `.json`, or a `.md`, and the
 *     file set it validates against comes from those same globs. The
 *     artifacts are invisible to it both as sources and as targets, so their
 *     URLs are resolved here instead — in the pass that is already reading
 *     them line by line.
 *   - **Agreement** — the metadata a page publishes matches where the page is
 *     served from, in both places it appears: the front matter of its
 *     Markdown, and the `inkeep:` meta tags the search index reads. It is
 *     derived at build time, so a mismatch means the derivation is wrong, not
 *     that a page is stale. The meta tags are worth checking on their own,
 *     because retrieval is filtered on them: a page whose line is wrong there
 *     is answered to readers of another release, and nothing on the page
 *     shows it.
 *
 * A line the manifest declares but whose content was never cut is skipped,
 * with a note: `tests/line-structure.test.ts` is what fails on that, and
 * failing twice for one cause buries the second finding.
 *
 * Usage (after `npm run build` and the Markdown splitter):
 *   bun run scripts/check-artifacts.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import {
  classifyUrl,
  collectionsFromManifest,
  extractUrls,
  leakReason,
  normalize,
  SITE_ORIGIN,
  type Collection,
  type Scope,
} from './lib/artifact-leakage.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(SCRIPT_DIR, '..', 'out');

/** Files Next.js writes for its own client navigation, not site content. */
const INTERNAL_PREFIX = '__next.';

/**
 * What an artifact is made of, which decides what isolation means for it.
 * A `list` names pages; a `corpus` carries their text, so its isolation is
 * which pages it contains rather than which paths its prose happens to name —
 * the prose is checked once, on the page's own Markdown.
 */
type Kind = 'list' | 'corpus';

interface Artifact {
  /** Path within the build, as the site serves it. */
  url: string;
  file: string;
  kind: Kind;
  /** The line it belongs to, or null when it speaks for the whole site. */
  scope: Scope | null;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return [full];
    }),
  );
  return files.flat();
}

/** Every path the build serves, in both slash forms, for resolution. */
function servedPaths(files: string[]): Set<string> {
  const served = new Set<string>();
  for (const file of files) {
    const relative = file.slice(OUT_DIR.length).replaceAll(path.sep, '/');
    if (path.basename(relative).startsWith(INTERNAL_PREFIX)) continue;

    served.add(relative);
    if (relative.endsWith('/index.html')) {
      const directory = relative.slice(0, -'/index.html'.length);
      served.add(directory || '/');
    }
  }
  return served;
}

/** The prefixes a site-relative URL can start with, read from the build. */
async function rootPrefixes(): Promise<string[]> {
  const entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => `/${entry.name}`);
}

/** The artifacts to read, and the line each one speaks for. */
function artifacts(
  collections: Collection[],
  served: Set<string>,
): { found: Artifact[]; missing: string[] } {
  const found: Artifact[] = [];
  const missing: string[] = [];

  function add(url: string, kind: Kind, scope: Scope | null) {
    if (!served.has(url)) missing.push(url);
    else found.push({ url, file: path.join(OUT_DIR, url), kind, scope });
  }

  add('/llms.txt', 'list', null);
  add('/llms-full.txt', 'corpus', null);

  for (const collection of collections) {
    add(`${collection.path}/llms.txt`, 'list', null);
    add(`${collection.path}/versions.json`, 'list', null);

    for (const line of collection.lines) {
      const scope = { collection: collection.path, version: line.version };
      add(`${collection.path}/${line.version}/llms.txt`, 'list', scope);
      add(
        line.current
          ? `${collection.path}/llms-full.txt`
          : `${collection.path}/${line.version}/llms-full.txt`,
        'corpus',
        scope,
      );
    }
  }

  return { found, missing };
}

/** The pages a corpus carries, read from the heading that opens each one. */
function corpusPages(text: string): string[] {
  return [...text.matchAll(/^# .*\((\/[^)\s]*)\)$/gm)].map((match) => match[1]);
}

/**
 * Routes that are not documentation pages: Next.js error pages, and the
 * standalone app routes the site serves beside the docs. Neither is written
 * in MDX, so neither has a Markdown twin or a place in the agent corpora.
 */
const NOT_PAGES = ['/404', '/_not-found', '/keet'];

/**
 * Every page of the build, by the URL it is served at: whatever directory
 * holds an `index.html`. Read that way rather than by the shape of the path,
 * because a line's own index (`/sdk/v0.18`) carries a dot like a file does.
 */
function pageUrls(served: Set<string>): string[] {
  return [...served]
    .filter((file) => file.endsWith('/index.html'))
    .map((file) => file.slice(0, -'/index.html'.length))
    .filter((url) => url !== '' && !NOT_PAGES.includes(url));
}

/**
 * The lines the manifest declares but whose content folder was never cut.
 * They are reported by `tests/line-structure.test.ts`, which says it once and
 * says it precisely; here they would say it again for every artifact that
 * names them, burying whatever else this pass found.
 */
function uncutLines(collections: Collection[], served: Set<string>): Set<string> {
  const uncut = new Set<string>();
  for (const collection of collections) {
    for (const line of collection.lines) {
      const index = line.current
        ? collection.path
        : `${collection.path}/${line.version}`;
      if (!served.has(index)) uncut.add(`${collection.path}@${line.version}`);
    }
  }
  return uncut;
}

/** `--- ... ---` at the top of a Markdown twin, as flat key/value pairs. */
function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const value = line.slice(at + 1).trim();
    fields[line.slice(0, at).trim()] = value.replace(/^"(.*)"$/, '$1');
  }
  return fields;
}

/**
 * The same claims as they appear in a built page: the canonical link and the
 * `inkeep:` meta tags, read into the field names the Markdown uses so one
 * comparison serves both surfaces. Attributes are matched individually rather
 * than as a fixed pattern, since their order in the tag is not ours to fix.
 */
function publishedAttributes(html: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    if (!/\brel="canonical"/.test(tag)) continue;
    const href = /\bhref="([^"]*)"/.exec(tag);
    if (href) fields.canonical = href[1];
  }

  for (const [tag] of html.matchAll(/<meta\b[^>]*>/g)) {
    const name = /\bname="inkeep:([^"]+)"/.exec(tag);
    const content = /\bcontent="([^"]*)"/.exec(tag);
    if (name && content) fields[name[1]] = content[1];
  }

  return fields;
}

/** What a page's Markdown must state, given only where the page is served. */
function metadataProblems(
  url: string,
  fields: Record<string, string>,
  collections: Collection[],
): string[] {
  const problems: string[] = [];
  const canonical = `${SITE_ORIGIN}${url}/`;
  if (fields.canonical !== canonical) {
    problems.push(`canonical is ${fields.canonical ?? 'absent'}, expected ${canonical}`);
  }

  const collection = collections.find(
    (entry) => url === entry.path || url.startsWith(`${entry.path}/`),
  );
  if (!collection) {
    if (fields.line) {
      problems.push(`states line ${fields.line}, but publishes no lines`);
    }
    return problems;
  }

  const expected = classifyUrl(url, collections);
  if (expected.kind !== 'line') return problems;

  const current = collection.lines.find((line) => line.current);
  if (fields.line !== expected.version) {
    problems.push(`states line ${fields.line ?? 'none'}, expected ${expected.version}`);
  }
  if (fields.package !== collection.package) {
    problems.push(`states package ${fields.package ?? 'none'}, expected ${collection.package}`);
  }
  const isCurrent = String(expected.version === current?.version);
  if (fields.current_line !== isCurrent) {
    problems.push(`states current_line ${fields.current_line ?? 'none'}, expected ${isCurrent}`);
  }
  return problems;
}

async function main() {
  let files: string[];
  try {
    files = await walk(OUT_DIR);
  } catch {
    throw new Error(
      `No build output at ${OUT_DIR}. Run \`npm run build\` before checking.`,
    );
  }

  const collections = collectionsFromManifest();
  const served = servedPaths(files);
  const prefixes = [...(await rootPrefixes()), '/llms.txt', '/llms-full.txt'];
  const pages = pageUrls(served);
  const uncut = uncutLines(collections, served);

  const problems: string[] = [];
  const notes: string[] = [];

  /** True when a URL points into a line that has no content yet. */
  function intoUncutLine(url: string): boolean {
    const target = classifyUrl(url, collections);
    return (
      target.kind === 'line' &&
      uncut.has(`${target.collection}@${target.version}`)
    );
  }

  const { found, missing } = artifacts(collections, served);
  for (const url of missing) {
    problems.push(`missing artifact: ${url}`);
  }

  // Read the artifacts once, classifying every URL they name.
  let checkedUrls = 0;
  for (const artifact of found) {
    if (
      artifact.scope &&
      uncut.has(`${artifact.scope.collection}@${artifact.scope.version}`)
    ) {
      notes.push(
        `${artifact.url} skipped — line ${artifact.scope.version} of ${artifact.scope.collection} is declared but not cut`,
      );
      continue;
    }

    const text = await fs.readFile(artifact.file, 'utf-8');

    if (artifact.kind === 'corpus') {
      const carried = corpusPages(text);
      for (const page of carried) {
        checkedUrls += 1;
        const reason = leakReason(page, artifact.scope, collections);
        if (reason) problems.push(`${artifact.url} carries ${page}, which ${reason}`);
        if (!served.has(normalize(page))) {
          problems.push(`${artifact.url} carries ${page}, which the build does not serve`);
        }
      }
      continue;
    }

    for (const url of extractUrls(text, prefixes)) {
      checkedUrls += 1;
      const reason = leakReason(url, artifact.scope, collections);
      if (reason) problems.push(`${artifact.url} references ${url}, which ${reason}`);
      if (!served.has(normalize(url)) && !intoUncutLine(url)) {
        problems.push(`${artifact.url} references ${url}, which the build does not serve`);
      }
    }
  }

  // Every page: that it publishes the right line to the search index, that
  // its Markdown twin exists, and that what the twin states about where it
  // comes from matches where it is served.
  for (const url of pages) {
    const html = await fs.readFile(path.join(OUT_DIR, url, 'index.html'), 'utf-8');
    for (const problem of metadataProblems(url, publishedAttributes(html), collections)) {
      problems.push(`${url} meta ${problem}`);
    }

    const file = path.join(OUT_DIR, `${url}.md`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch {
      problems.push(`missing Markdown twin: ${url}.md`);
      continue;
    }

    for (const problem of metadataProblems(url, frontMatter(text), collections)) {
      problems.push(`${url}.md ${problem}`);
    }

    const scope = classifyUrl(url, collections);
    if (scope.kind !== 'line') continue;
    for (const link of extractUrls(text, prefixes)) {
      checkedUrls += 1;
      const reason = leakReason(link, scope, collections);
      if (reason) problems.push(`${url}.md references ${link}, which ${reason}`);
      if (!served.has(normalize(link))) {
        problems.push(`${url}.md references ${link}, which the build does not serve`);
      }
    }
  }

  for (const note of notes) {
    console.log(`… ${note}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    throw new Error(`${problems.length} artifact problem(s)`);
  }

  console.log(
    `Agent artifacts check passed: ${found.length} artifacts, ${pages.length} pages with matching metadata and Markdown twins, ${checkedUrls} URLs resolved and scoped`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

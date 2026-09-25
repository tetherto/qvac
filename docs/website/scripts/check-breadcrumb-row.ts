#!/usr/bin/env bun
/**
 * Checks the row above each page's heading in the built site: the trail
 * naming where the page sits, and the label naming the release it documents.
 *
 * One check for both, because they share a row. Two checks that each located
 * "the row" by their own rule would eventually disagree about which element
 * it is, and the disagreement would surface as one of them quietly passing.
 *
 * Both halves fail silently on their own:
 *
 *   - **The trail** borrows its path walk from `fumadocs-core`, so a minor
 *     upgrade can change one of its rules — the root reset, the folder-index
 *     collapse — and nothing else notices, because every URL a shortened
 *     trail still names resolves. The collection must lead it, the collection
 *     entry must point at the reader's own documentation line rather than the
 *     one the collection currently serves, the page must close it without a
 *     link, and a collection or line index must carry no trail at all.
 *   - **The label** must agree with the page's published metadata. Those
 *     attributes are what retrieval filters on and what an agent reads, and
 *     `check-artifacts.ts` already holds them to the page's route — so the
 *     label is checked against them rather than against a list kept here.
 *     Every page whose Markdown declares a line must carry a label naming
 *     that line, drawn in the treatment its standing calls for; every page
 *     whose Markdown declares none must carry no label. Cutting a new line
 *     therefore needs no edit to this file.
 *
 * The last assertion is about what is no longer there: the sentence that used
 * to be injected into every versioned page's prose. Removing the plugin is
 * the whole removal, and this is its only guard.
 *
 * Properties are checked, never the words of a trail: a page retitled is not
 * a regression.
 *
 * Usage (after `npm run build`):
 *   bun run scripts/check-breadcrumb-row.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

/** The class the trail's container carries, copied from the framework's own. */
const TRAIL_MARKER =
  'flex items-center gap-1.5 text-sm text-fd-muted-foreground';

/** The class the row itself carries, holding the trail and the label. */
const ROW_MARKER = 'flex items-center gap-4';

/** The shape shared by both treatments of the release label. */
const LABEL_MARKER = 'rounded-full px-2 py-0.5 text-xs font-medium';

/** The brand treatment, worn only by the current line. */
const CURRENT_TREATMENT = 'bg-fd-primary/10 text-fd-primary';

/** The neutral treatment, worn by every past line. */
const PAST_TREATMENT = 'bg-fd-muted text-fd-muted-foreground';

/** What the label appends for a reader who cannot see which treatment it wears. */
const STANDING = {
  current: ', the current release',
  past: ', not the current release',
};

/** The sentence the release label replaced, as it appeared in a page's Markdown. */
const INJECTED_SENTENCE = /^\*Applies to `[^`]+` v[\d.]+[^*]*\*$/m;

/**
 * The viewports the sidebar is rendered at, read off the built page.
 *
 * The sidebar element itself carries no responsive class; its placeholder
 * does, as `max-<breakpoint>:hidden`. That value belongs to the documentation
 * framework's layout, and the label's own condition has to be its exact
 * complement — otherwise a framework change to it leaves the label wrong on
 * one band of viewports, with the switcher gone and nothing in its place.
 *
 * Derived rather than held as a constant here, so that change fails the build
 * instead of passing.
 */
function sidebarBreakpoint(html: string): string | null {
  const placeholder = html.match(/data-sidebar-placeholder[^>]*class="([^"]*)"/);
  if (!placeholder) return null;
  return placeholder[1].match(/\bmax-(\w+):hidden\b/)?.[1] ?? null;
}

interface Entry {
  name: string;
  url: string | null;
}

interface Label {
  line: string;
  current: boolean;
  standing: string;
  classes: string;
}

/**
 * Pages whose trail must lead to a named collection index, at several depths,
 * including a page of each cut documentation line — the line is what the
 * collection entry has to get right.
 */
const EXPECTED_TRAILS: { page: string; leadsTo: string; depth: number }[] = [
  { page: 'sdk/configuration', leadsTo: '/sdk/', depth: 2 },
  { page: 'sdk/configuration/plugins', leadsTo: '/sdk/', depth: 3 },
  {
    page: 'sdk/configuration/plugins/write-custom-plugin',
    leadsTo: '/sdk/',
    depth: 4,
  },
  { page: 'sdk/v0.18/configuration/plugins', leadsTo: '/sdk/v0.18', depth: 3 },
  { page: 'sdk/v0.19/configuration/plugins', leadsTo: '/sdk/v0.19', depth: 3 },
  { page: 'cli/http-server', leadsTo: '/cli/', depth: 2 },
  { page: 'cli/v0.12/http-server', leadsTo: '/cli/v0.12', depth: 2 },
  { page: 'ecosystem/addons/llm-llamacpp', leadsTo: '/ecosystem/', depth: 3 },
  { page: 'ecosystem/inventory/sdk', leadsTo: '/ecosystem/', depth: 3 },
  { page: 'resources/tutorials/electron', leadsTo: '/resources/', depth: 2 },
];

/**
 * Pages that must carry no trail: every collection index, a cut line's index,
 * and an inventory package version — which is a root in its own right, and so
 * is its own index.
 */
const TRAILLESS = [
  'sdk',
  'cli',
  'ecosystem',
  'resources',
  'sdk/v0.18',
  'cli/v0.12',
  'ecosystem/inventory/sdk/v0.20',
];

/** The span of a built page between its article and its heading. */
function rowRegion(html: string): string | null {
  const article = html.indexOf('<article id="nd-page"');
  if (article === -1) return null;
  const heading = html.indexOf('<h1', article);
  return html.slice(article, heading === -1 ? undefined : heading);
}

/** The trail of one built page, in order, or null when the page has none. */
function readTrail(html: string): Entry[] | null {
  const region = rowRegion(html);
  if (region === null) return null;

  const start = region.indexOf(`class="${TRAIL_MARKER}"`);
  if (start === -1) return null;

  // Bounded by its own container's close, so the parse stops short of the
  // release label sitting beside it on the same row. The trail nests no
  // `div`, so the first close is its own.
  const close = region.indexOf('</div>', start);
  const container = region.slice(start, close === -1 ? undefined : close);

  const entries: Entry[] = [];
  const pattern =
    /<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>|<span\b[^>]*>([^<]*)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(container)) !== null) {
    const [, url, linked, plain] = match;
    entries.push({ name: (linked ?? plain ?? '').trim(), url: url ?? null });
  }

  return entries.length > 0 ? entries : null;
}

/** The release label of one built page, or null when the page carries none. */
function readLabel(html: string): Label | null {
  const region = rowRegion(html);
  if (region === null) return null;

  const match = region.match(
    new RegExp(
      `<span class="([^"]*${LABEL_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*)">([^<]*)<span class="sr-only">([^<]*)</span>`,
    ),
  );
  if (!match) return null;

  const [, classes, line, standing] = match;
  return {
    line: line.trim(),
    current: classes.includes(CURRENT_TREATMENT),
    standing,
    classes,
  };
}

/** The `line` and `current_line` a page's Markdown twin declares. */
function readMetadata(md: string): { line: string; current: boolean } | null {
  const end = md.indexOf('\n---', 4);
  const front = md.slice(0, end === -1 ? undefined : end);
  const line = front.match(/^line:\s*(\S+)$/m);
  if (!line) return null;
  return { line: line[1], current: /^current_line:\s*true$/m.test(front) };
}

/** Every built docs page, as the path of its `index.html` minus `out/`. */
async function builtPages(dir: string, prefix = ''): Promise<string[]> {
  const pages: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const here = prefix ? `${prefix}/${entry.name}` : entry.name;
    // A docs page is one with a Markdown twin beside its directory. That is
    // what pairs the rendered page with the metadata it must agree with, and
    // it excludes the build's own pages — 404, not-found, the API routes.
    try {
      await fs.access(path.join(dir, `${entry.name}.md`));
      pages.push(here);
    } catch {
      /* not a docs page; its children may still be */
    }
    pages.push(...(await builtPages(path.join(dir, entry.name), here)));
  }
  return pages;
}

async function main(): Promise<void> {
  const problems: string[] = [];

  const read = async (page: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(OUT, page, 'index.html'), 'utf8');
    } catch {
      return null;
    }
  };

  // The trail, at the depths and on the pages whose shape it must have.
  for (const { page, leadsTo, depth } of EXPECTED_TRAILS) {
    const html = await read(page);
    if (html === null) {
      problems.push(`${page}: not in the build`);
      continue;
    }

    const trail = readTrail(html);
    if (trail === null) {
      problems.push(`${page}: has no trail above its heading`);
      continue;
    }

    if (trail.length !== depth) {
      problems.push(
        `${page}: the trail has ${trail.length} entries, expected ${depth} — ${trail
          .map((entry) => entry.name)
          .join(' > ')}`,
      );
    }

    if (trail[0].url !== leadsTo) {
      problems.push(
        `${page}: the trail leads to ${trail[0].url}, not the index of its own line ${leadsTo}`,
      );
    }

    const last = trail[trail.length - 1];
    if (last.url !== null) {
      problems.push(
        `${page}: the trail's last entry links ${last.url} rather than naming the page the reader is on`,
      );
    }

    for (const entry of trail.slice(0, -1)) {
      if (entry.url === null) {
        problems.push(`${page}: the trail's "${entry.name}" entry leads nowhere`);
      }
      if (entry.name.length === 0) {
        problems.push(`${page}: the trail carries an unnamed entry`);
      }
    }
  }

  for (const page of TRAILLESS) {
    const html = await read(page);
    if (html === null) {
      problems.push(`${page}: not in the build`);
      continue;
    }
    const trail = readTrail(html);
    if (trail !== null) {
      problems.push(
        `${page}: a collection or line index carries a trail — ${trail
          .map((entry) => entry.name)
          .join(' > ')}`,
      );
      continue;
    }

    // A row with no trail holds nothing but the label, so it is shown only
    // where the label is. Left unconditioned it would be an empty flex
    // container above the heading at every viewport the sidebar is at.
    const breakpoint = sidebarBreakpoint(html);
    if (readLabel(html) !== null && breakpoint !== null) {
      const region = rowRegion(html) ?? '';
      if (!region.includes(`class="${ROW_MARKER} ${breakpoint}:hidden"`)) {
        problems.push(
          `${page}: its row holds only the label, so it must carry ${breakpoint}:hidden and be gone with it`,
        );
      }
    }
  }

  // The label, on every page, against the metadata that page publishes.
  const pages = await builtPages(OUT);
  const mismatched = new Map<string, number>();
  let labelled = 0;
  let unlabelled = 0;

  for (const page of pages) {
    const html = await read(page);
    const md = await fs.readFile(path.join(OUT, `${page}.md`), 'utf8');
    if (html === null) {
      problems.push(`${page}: has a Markdown twin but no built page`);
      continue;
    }

    if (INJECTED_SENTENCE.test(md)) {
      problems.push(`${page}: its Markdown states its release in the prose`);
    }

    const expected = readMetadata(md);
    const label = readLabel(html);

    if (expected === null) {
      if (label !== null) {
        problems.push(
          `${page}: carries the label "${label.line}" while declaring no documentation line`,
        );
      } else {
        unlabelled++;
      }
      continue;
    }

    if (label === null) {
      problems.push(
        `${page}: declares the line ${expected.line} and carries no label`,
      );
      continue;
    }

    labelled++;

    if (label.line !== expected.line) {
      problems.push(
        `${page}: is labelled ${label.line} while its metadata declares ${expected.line}`,
      );
    }
    if (label.current !== expected.current) {
      problems.push(
        `${page}: wears the ${label.current ? 'brand' : 'neutral'} treatment while its line ${
          expected.current ? 'is' : 'is not'
        } the current one`,
      );
    }
    const standing = expected.current ? STANDING.current : STANDING.past;
    if (label.standing !== standing) {
      problems.push(
        `${page}: states its standing as "${label.standing}", not "${standing}"`,
      );
    }

    // One component emits every label, so a disagreement with the sidebar is
    // the same disagreement on all 120 pages. Collected by its wording and
    // reported once, with the pages counted.
    const breakpoint = sidebarBreakpoint(html);
    const complaint =
      breakpoint === null
        ? 'no sidebar placeholder carries a max-<breakpoint>:hidden class, so the label cannot be checked against the sidebar it must be the complement of'
        : !label.classes.split(/\s+/).includes(`${breakpoint}:hidden`)
          ? `the sidebar is hidden by max-${breakpoint}:hidden, so the label must carry ${breakpoint}:hidden and carries "${label.classes}"`
          : null;
    if (complaint) {
      mismatched.set(complaint, (mismatched.get(complaint) ?? 0) + 1);
    }
  }

  for (const [complaint, count] of mismatched) {
    problems.push(`${complaint} — on ${count} page(s)`);
  }

  if (labelled === 0 || unlabelled === 0) {
    problems.push(
      `the sweep found ${labelled} labelled and ${unlabelled} unlabelled pages; both sides must be exercised`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    throw new Error(`${problems.length} breadcrumb-row problem(s)`);
  }

  console.log(
    `Breadcrumb row check passed: ${EXPECTED_TRAILS.length} trails lead to their own line and end unlinked, ${TRAILLESS.length} indexes carry none, ${labelled} pages labelled as their metadata declares and ${unlabelled} correctly bare`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

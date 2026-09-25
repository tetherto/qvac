#!/usr/bin/env bun
/**
 * Checks the navbar's link bar in the built site: the row of icon-only
 * anchors leading away from the documentation.
 *
 * The bar is declared once, in `src/app/(docs)/layout.tsx`, and Fumadocs
 * renders it on every page. What the declaration says and what the anchor
 * carries are two different things, and only the second one reaches a reader:
 *
 *   - **Naming** — an entry is a glyph and nothing else, so its accessible
 *     name comes entirely from the `label` the declaration gives it. Omit
 *     `label` and the anchor still renders, still works with a mouse, and is
 *     announced as an unnamed link. Nothing on the page shows it, and two of
 *     these shipped that way for as long as the bar has existed.
 *   - **Order** — the product's own site leads. The rest are places the
 *     project is found, and which of them comes first is a matter of taste;
 *     that the product's home is not buried among them is not.
 *   - **Departure** — an entry that leaves the site opens in a new tab and
 *     withholds the referrer. Fumadocs derives both from `external`, so this
 *     catches an entry declared without it.
 *   - **Uniformity** — the bar is chrome, identical on every page. It is
 *     rendered twice per page (the wide navbar and the one that collapses),
 *     and every collection and every documentation line draws the same one.
 *     A layout that diverged per collection would be a regression no page
 *     shows on its own.
 *
 * Usage (after `npm run build`):
 *   bun run scripts/check-navbar-links.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

/** Where the product's own site lives, and what must lead the bar. */
const MAIN_SITE = 'https://qvac.tether.io';

/**
 * One page per collection, plus a cut line of each versioned collection. The
 * bar is chrome, so a handful of pages drawn from every layout the site has
 * is enough to show it does not vary.
 */
const PAGES = [
  'ecosystem/index.html',
  'sdk/index.html',
  'cli/index.html',
  'resources/index.html',
  'sdk/v0.19/index.html',
  'cli/v0.13/index.html',
];

/**
 * The class Fumadocs puts on an icon-sized button. It is what distinguishes
 * the bar's anchors from every other link on the page.
 */
const ICON_ANCHOR_MARKER = '[&amp;_svg]:size-4.5';

interface Entry {
  href: string;
  name: string | null;
  blank: boolean;
  rel: string;
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/** The bar's anchors on one page, in the order they appear in the document. */
function readBar(html: string): Entry[] {
  const entries: Entry[] = [];
  const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;

  while ((match = anchor.exec(html)) !== null) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1);
    if (!tag.includes(ICON_ANCHOR_MARKER)) continue;

    // An icon-only anchor is named by `aria-label`; one that also renders text
    // is named by the text. Take either, so the check survives an entry that
    // stops being icon-only.
    const text = match[1].replace(/<[^>]*>/g, '').trim();
    entries.push({
      href: attribute(tag, 'href') ?? '',
      name: attribute(tag, 'aria-label') ?? (text.length > 0 ? text : null),
      blank: attribute(tag, 'target') === '_blank',
      rel: attribute(tag, 'rel') ?? '',
    });
  }

  return entries;
}

/** Whether an entry leads away from the documentation site. */
function leavesTheSite(href: string): boolean {
  return /^https?:\/\//.test(href);
}

function shape(entries: Entry[]): string {
  return entries.map((entry) => `${entry.href} (${entry.name ?? '—'})`).join(' | ');
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const shapes = new Map<string, string[]>();

  for (const page of PAGES) {
    const file = path.join(OUT, page);
    let html: string;
    try {
      html = await fs.readFile(file, 'utf8');
    } catch {
      problems.push(`${page}: not in the build`);
      continue;
    }

    const entries = readBar(html);
    if (entries.length === 0) {
      problems.push(`${page}: the navbar link bar is missing`);
      continue;
    }

    // The bar is rendered once per navbar, and the page has more than one.
    // Split the run into equal renderings and require them to agree.
    const perRendering = entries.length % 2 === 0 ? entries.length / 2 : entries.length;
    const first = entries.slice(0, perRendering);
    const second = entries.slice(perRendering);
    if (second.length > 0 && shape(first) !== shape(second)) {
      problems.push(
        `${page}: the page's two link bars disagree — ${shape(first)} vs ${shape(second)}`,
      );
    }

    if (first[0].href !== MAIN_SITE) {
      problems.push(
        `${page}: the link bar leads with ${first[0].href}, not the product's site ${MAIN_SITE}`,
      );
    }

    for (const entry of first) {
      if (entry.name === null || entry.name.length === 0) {
        problems.push(`${page}: the entry linking to ${entry.href} has no accessible name`);
      }
      if (!leavesTheSite(entry.href)) continue;
      if (!entry.blank) {
        problems.push(`${page}: the entry linking to ${entry.href} leaves the site in place`);
      }
      if (!entry.rel.includes('noreferrer') || !entry.rel.includes('noopener')) {
        problems.push(
          `${page}: the entry linking to ${entry.href} leaves the site without rel="noreferrer noopener"`,
        );
      }
    }

    const key = shape(first);
    shapes.set(key, [...(shapes.get(key) ?? []), page]);
  }

  if (shapes.size > 1) {
    const rendered = [...shapes.entries()]
      .map(([key, pages]) => `  ${pages.join(', ')}: ${key}`)
      .join('\n');
    problems.push(`the link bar is not the same on every page:\n${rendered}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    throw new Error(`${problems.length} navbar link problem(s)`);
  }

  const [bar] = [...shapes.keys()];
  console.log(
    `Navbar links check passed: ${bar.split(' | ').length} named entries, identical across ${PAGES.length} pages`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

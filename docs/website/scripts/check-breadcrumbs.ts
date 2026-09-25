#!/usr/bin/env bun
/**
 * Checks the trail above each page's heading in the built site.
 *
 * The trail is composed by `src/components/page-breadcrumb.tsx`, which
 * borrows its path walk from `fumadocs-core` and owns only the two ends. The
 * borrowed half is the fragile half, and it fails silently:
 *
 *   - **The collection** leads the trail because the component asks for the
 *     root, which the framework otherwise treats as where a trail starts
 *     rather than a step in it. A framework change to that rule drops the
 *     entry, and nothing else notices — every remaining URL still resolves.
 *   - **The line** the collection entry leads to is the reader's own, not the
 *     release the collection currently serves. A trail that climbed out of
 *     `v0.18` into the current line would move a reader between releases
 *     without saying so, which is the failure the lines exist to prevent.
 *   - **The page** closes the trail and carries no link. The framework
 *     appends it with its URL, so this is a correction the component makes,
 *     and a correction is exactly what an upgrade can undo.
 *   - **A collection index** carries no trail at all, since the page is the
 *     collection and a trail there would name it twice.
 *
 * The properties are checked, never the text: a page retitled is not a
 * regression, and asserting the words would make every title edit a test
 * edit.
 *
 * Usage (after `npm run build`):
 *   bun run scripts/check-breadcrumbs.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

/** The class the trail's container carries, copied from the framework's own. */
const TRAIL_MARKER =
  'flex items-center gap-1.5 text-sm text-fd-muted-foreground';

interface Entry {
  name: string;
  url: string | null;
}

/**
 * Pages whose trail must lead to a named collection index. One per collection
 * at two depths, plus a page of each cut documentation line, since the line is
 * what the collection entry has to get right.
 */
const EXPECTED: { page: string; leadsTo: string; depth: number }[] = [
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

/** The trail of one built page, in order, or null when the page has none. */
function readTrail(html: string): Entry[] | null {
  const article = html.indexOf('<article id="nd-page"');
  if (article === -1) return null;

  const start = html.indexOf(`class="${TRAIL_MARKER}"`, article);
  const heading = html.indexOf('<h1', article);
  if (start === -1 || (heading !== -1 && start > heading)) return null;

  const open = html.lastIndexOf('<div', start);
  const trail = html.slice(open, heading === -1 ? undefined : heading);

  const entries: Entry[] = [];
  const pattern =
    /<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>|<span\b[^>]*>([^<]*)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(trail)) !== null) {
    const [, url, linked, plain] = match;
    entries.push({ name: (linked ?? plain ?? '').trim(), url: url ?? null });
  }

  return entries.length > 0 ? entries : null;
}

async function read(page: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(OUT, page, 'index.html'), 'utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const problems: string[] = [];

  for (const { page, leadsTo, depth } of EXPECTED) {
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

    const [first] = trail;
    if (first.url !== leadsTo) {
      problems.push(
        `${page}: the trail leads to ${first.url}, not the index of its own line ${leadsTo}`,
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
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`✗ ${problem}`);
    }
    throw new Error(`${problems.length} breadcrumb problem(s)`);
  }

  console.log(
    `Breadcrumb check passed: ${EXPECTED.length} trails lead to their own line and end unlinked, ${TRAILLESS.length} indexes carry none`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

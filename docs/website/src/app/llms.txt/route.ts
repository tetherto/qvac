import {
  CORPUS_PROTOCOL_URL,
  currentVersionOf,
  formatPageEntry,
  formatSectionTitle,
  unversionedPages,
  versionedCollections,
  versionsUrl,
} from '@/lib/artifacts';
import { collectionTabs } from '@/lib/custom-tree';
import type { InferPageType } from 'fumadocs-core/source';
import type { source } from '@/lib/source';

// Resolves the response at build time so the result is written to
// `out/llms.txt` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

type Page = InferPageType<typeof source>;

const ROOT_SECTION = '(root)';

/**
 * The collections in the order the collection bar lists them, read from the
 * entries that render the bar so the two never drift apart.
 */
const COLLECTION_ORDER = collectionTabs.map((tab) => tab.url.slice(1));

/**
 * Generates the root `llms.txt` at build time.
 *
 * It is a router, not a catalogue. A versioned collection is represented by
 * its resolver, one fetch away, which names the lines and their indexes;
 * listing that collection's pages here would mean either mixing two releases
 * in one list or silently picking one for the reader. An unversioned
 * collection has no such choice to make, so its pages are listed directly.
 *
 * Format follows the de-facto convention popularized by https://llmstxt.org/:
 * an H1 with the project name, a short paragraph describing the site, a
 * "Guidance" preamble, and `## Section` headings whose body is a bullet list
 * of `- [Title](url): description` entries.
 */
export function GET() {
  const collections = versionedCollections();
  const pages = unversionedPages();
  const grouped = groupPagesBySection(pages);

  const lines: string[] = [
    '# QVAC Documentation',
    '',
    "Agent index for the QVAC developer documentation. QVAC is Tether's local-first AI SDK for cross-platform, peer-to-peer applications.",
    '',
    '## Guidance',
    '',
    '- To fetch one page as Markdown, append `.md` to its path (e.g. `/sdk/js-ts-sdk` → `/sdk/js-ts-sdk.md`). Alternatively, send the HTTP header `Accept: text/markdown` and any page URL will be redirected to its Markdown variant.',
    '- When citing sources to users, use the canonical URL without `.md` (e.g. `/sdk/js-ts-sdk`), not the Markdown variant.',
    `- Some collections are versioned: they publish one documentation line per release, and each line has its own page index and its own full-text corpus. Resolve the line that matches the release you are working against before reading anything else. How to do that: ${CORPUS_PROTOCOL_URL}`,
    '- To obtain a dump of everything at once, fetch `/llms-full.txt`. It carries the unversioned collections and the current line of each versioned one.',
    '',
    '## Versioned collections',
    '',
  ];

  for (const { software, path, lines: published } of collections) {
    lines.push(
      `- ${titleOf(path)} — tracks \`${software.package}\`, current line ${currentVersionOf(software)}, ${published.length} lines published. Resolver: ${path}/llms.txt. Machine-readable: ${versionsUrl(path)}`,
    );
  }

  for (const section of Object.keys(grouped).sort(compareSections)) {
    lines.push('', `## ${formatSectionTitle(section)}`, '');
    for (const page of grouped[section]) {
      lines.push(formatPageEntry(page));
    }
  }

  return new Response(lines.join('\n') + '\n');
}

/** The collection bar's name for a path, falling back to the path itself. */
function titleOf(path: string): string {
  return collectionTabs.find((tab) => tab.url === path)?.title ?? path;
}

/**
 * Groups by collection and then by the section within it, so a heading reads
 * `Platform / Addons`. Grouping by the first slug alone would put every page
 * of a collection under one heading, since the collection occupies the slot
 * the section used to.
 */
function groupPagesBySection(pages: Page[]): Record<string, Page[]> {
  const initial: Record<string, Page[]> = {};
  for (const page of pages) {
    const [collection, section] = page.slugs;
    const key = collection
      ? section
        ? `${collection}/${section}`
        : collection
      : ROOT_SECTION;
    (initial[key] ??= []).push(page);
  }

  // A section holding a single page directly under its collection (say
  // `/resources/overview`) folds into the collection's own heading, rather
  // than spawning a one-entry section of its own.
  const collapsed: Record<string, Page[]> = {};
  for (const [key, list] of Object.entries(initial)) {
    if (list.length === 1 && list[0].slugs.length === 2) {
      (collapsed[list[0].slugs[0]] ??= []).push(list[0]);
    } else {
      collapsed[key] = list;
    }
  }
  return collapsed;
}

/** Sorts alphabetically, but after every collection the bar knows about. */
function collectionRank(collection: string): number {
  const rank = COLLECTION_ORDER.indexOf(collection);
  return rank === -1 ? COLLECTION_ORDER.length : rank;
}

/**
 * Orders collections as the collection bar presents them, and within one puts
 * the collection's own pages ahead of its sections.
 */
function compareSections(a: string, b: string): number {
  if (a === ROOT_SECTION) return -1;
  if (b === ROOT_SECTION) return 1;

  const [aCollection, aSection] = a.split('/');
  const [bCollection, bSection] = b.split('/');
  if (aCollection !== bCollection) {
    return collectionRank(aCollection) - collectionRank(bCollection);
  }
  if (!aSection) return -1;
  if (!bSection) return 1;
  return aSection.localeCompare(bSection);
}

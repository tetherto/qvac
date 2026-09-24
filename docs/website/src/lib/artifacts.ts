/**
 * What every agent artifact is built from.
 *
 * The artifacts are addressed by line, not by currency: each line's index
 * lives at `/{collection}/v{major}.{minor}/llms.txt`, the current line
 * included, so an agent that resolved a version out of a lockfile reaches the
 * matching index by substitution rather than by first learning which line is
 * current. The corpora keep the URL rule the pages follow — the current
 * line's at the collection's version-less path, another line's at its
 * versioned path — because a corpus is the content itself, and the content of
 * the current line is what the version-less paths serve.
 */

import type { InferPageType } from 'fumadocs-core/source';
import { source } from '@/lib/source';
import { collectionLines, type CollectionLines, type Line } from '@/lib/lines';
import {
  getCurrentLine,
  getDocumentedSoftware,
  type DocumentedSoftware,
} from '@/lib/versions';

type Page = InferPageType<typeof source>;

/**
 * The page telling a coding agent how to pick a corpus. Named here because
 * the root router links it, and the page itself is the only other place that
 * knows the path.
 */
export const BUILD_WITH_AI_URL = '/resources/build-with-ai';

export interface VersionedCollection {
  software: DocumentedSoftware;
  /** The collection's path, absolute and without a trailing slash. */
  path: string;
  lines: Line[];
}

/** Every collection published as documentation lines, with those lines. */
export function versionedCollections(): VersionedCollection[] {
  return collectionLines(source.getPages().map((page) => page.url)).map(
    (collection: CollectionLines) => {
      const software = getDocumentedSoftware(collection.path);
      if (!software) {
        throw new Error(`No manifest entry for ${collection.path}`);
      }
      return { software, path: collection.path, lines: collection.lines };
    },
  );
}

/** The collection published at `path`, or null when it is not versioned. */
export function versionedCollection(path: string): VersionedCollection | null {
  return (
    versionedCollections().find((collection) => collection.path === path) ??
    null
  );
}

/** The pages of one line, in URL order. */
export function pagesOfLine(line: Line): Page[] {
  const urls = new Set(line.urls);
  return source
    .getPages()
    .filter((page) => urls.has(page.url))
    .sort((a, b) => a.url.localeCompare(b.url));
}

/** The pages of every collection that publishes no lines. */
export function unversionedPages(): Page[] {
  const versioned = new Set(
    versionedCollections().flatMap((collection) =>
      collection.lines.flatMap((line) => line.urls),
    ),
  );
  return source
    .getPages()
    .filter((page) => !versioned.has(page.url))
    .sort((a, b) => a.url.localeCompare(b.url));
}

/** Where a line's page index is published. */
export function lineIndexUrl(path: string, line: Line): string {
  return `${path}/${line.version}/llms.txt`;
}

/**
 * Where a line's full corpus is published: the version-less path for the
 * current line, since that is where its content is served, and the versioned
 * path for every other.
 */
export function lineCorpusUrl(path: string, line: Line): string {
  return line.current
    ? `${path}/llms-full.txt`
    : `${path}/${line.version}/llms-full.txt`;
}

/** Where a collection's machine-readable line index is published. */
export function versionsUrl(path: string): string {
  return `${path}/versions.json`;
}

/** The version the collection's current line publishes. */
export function currentVersionOf(software: DocumentedSoftware): string | null {
  return getCurrentLine(software)?.version ?? null;
}

/** `- [Title](/url): description`, the entry shape every index uses. */
export function formatPageEntry(page: Page): string {
  const description = page.data.description?.trim();
  const entry = `- [${page.data.title}](${page.url})`;
  return description ? `${entry}: ${description}` : entry;
}

/** Initialisms the `<= 3` rule below is too short to catch. */
const INITIALISMS = new Set(['http']);

/** `ai-capabilities` → `AI Capabilities`, one path segment at a time. */
export function formatSectionTitle(key: string): string {
  return key
    .split('/')
    .map((part) =>
      part
        .split('-')
        .map((word) =>
          word.length <= 3 || INITIALISMS.has(word)
            ? word.toUpperCase()
            : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join(' '),
    )
    .join(' / ');
}

/**
 * A line's pages as a Markdown index, grouped by the section they sit in.
 * Pages directly under the line lead, under an `Overview` heading; the rest
 * follow by section, alphabetically.
 *
 * `depth` is how many slug segments the line occupies — two for a versioned
 * line (`sdk`, `v0.16`), one for the current line, whose pages carry no
 * version segment.
 */
export function formatLineIndex(pages: Page[], depth: number): string[] {
  const grouped = new Map<string, Page[]>();
  for (const page of pages) {
    const within = page.slugs.slice(depth);
    const section = within.length > 1 ? within[0] : '';
    const list = grouped.get(section) ?? [];
    list.push(page);
    grouped.set(section, list);
  }

  const sections = [...grouped.keys()].sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b);
  });

  const lines: string[] = [];
  for (const section of sections) {
    lines.push('', `## ${section ? formatSectionTitle(section) : 'Overview'}`, '');
    for (const page of grouped.get(section) ?? []) {
      lines.push(formatPageEntry(page));
    }
  }
  return lines;
}

/** How many slug segments a line's own prefix occupies. */
export function lineDepth(line: Line): number {
  return line.current ? 1 : 2;
}

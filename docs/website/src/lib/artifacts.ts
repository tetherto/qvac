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

/**
 * The block every corpus opens with, naming what the corpus carries.
 *
 * A corpus is a single file an agent may be handed on its own, with none of
 * the hierarchy that would have told it which release it is reading. The
 * block is the only orientation such a reader gets: which line, which
 * package, how many pages, and what was withheld. `versions.json` stays the
 * machine-readable face of the line structure; this is prose for whoever
 * arrived without it.
 *
 * Release notes are withheld from every corpus that has any. They are
 * historical changelogs whose bulk inflates the token count without adding
 * context needed to use the release (QVAC-21379). The exclusion is stated
 * here because a corpus that drops pages silently cannot be told apart from
 * documentation that was never written.
 */
export function corpusHeader(
  scope:
    | {
        kind: 'site';
        collections: VersionedCollection[];
        pages: number;
        withheld: number;
      }
    | {
        kind: 'line';
        collection: VersionedCollection;
        line: Line;
        pages: number;
        withheld: number;
      },
): string {
  const lines: string[] = [];

  if (scope.kind === 'line') {
    const { collection, line, pages } = scope;
    const { software, path } = collection;
    const standing = line.current
      ? 'the current line, served at this collection’s version-less paths'
      : 'a past line, kept as it stood for that release';

    lines.push(
      `# ${software.package} ${line.version} — full text`,
      '',
      `Every page below documents ${software.package} ${line.version}: ${standing}. No page of another line appears here.`,
      '',
      'Contents of this corpus:',
      '',
      scope.withheld > 0
        ? `- ${pages} pages, the whole of this line except its release notes.`
        : `- ${pages} pages, the whole of this line.`,
      `- Page index for this line: ${lineIndexUrl(path, line)}`,
      // Never another line's URL. A line-scoped artifact that named one
      // would fail the leakage gate, which is why the line index resolves
      // siblings through the resolver rather than listing them.
      `- On another release? Resolve the line from ${path}/llms.txt, or ${versionsUrl(path)}`,
    );
  } else {
    lines.push(
      '# QVAC Documentation — full text',
      '',
      'Contents of this corpus:',
      '',
      `- ${scope.pages} pages.`,
      '- Every page of the collections that publish no versions.',
    );

    for (const { software, path, lines: published } of scope.collections) {
      const current = published.find((line) => line.current);
      if (!current) continue;
      const others = published.filter((line) => !line.current);
      lines.push(
        `- ${software.package} ${current.version}, the current line of ${path}. Other lines are not included here: ${others
          .map((line) => `${line.version} → ${lineCorpusUrl(path, line)}`)
          .join(', ')}`,
      );
    }
  }

  if (scope.withheld > 0) {
    const whereToFind =
      scope.kind === 'line' ? 'the index above' : 'the line index that lists it';
    lines.push(
      `- ${scope.withheld} release-notes ${scope.withheld === 1 ? 'page is' : 'pages are'} withheld. Fetch one as its own page, from ${whereToFind}.`,
    );
  }

  lines.push(`- How to pick a line: ${BUILD_WITH_AI_URL}`);

  return lines.join('\n');
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

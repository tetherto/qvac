/**
 * Classifies the URLs an agent artifact lists, so the build can tell a
 * reference that keeps the reader inside one release from one that walks them
 * out of it.
 *
 * A line's artifacts are the one surface where cross-line leakage is both
 * easy and silent: the content of two lines starts identical, and a paragraph
 * copied forward keeps whatever paths it named. The rendered pages are covered
 * by the link rewriting in `remark-line-links` and by the HTML broken-link
 * step; the artifacts are covered here.
 *
 * Pure, so the classifier can be tested against cases the built site does not
 * currently contain.
 */

import {
  documentedSoftwareOfKind,
  isCurrentLineFolder,
  type DocumentedSoftware,
} from '../../src/lib/versions.js';

export interface CollectionLine {
  version: string;
  current: boolean;
}

export interface Collection {
  /** The collection's path, absolute and without a trailing slash. */
  path: string;
  package: string;
  lines: CollectionLine[];
}

/** Where an artifact sits, and therefore which references it may make. */
export interface Scope {
  collection: string;
  version: string;
}

export type UrlClass =
  /** Outside every collection published as lines. */
  | { kind: 'unversioned' }
  | { kind: 'line'; collection: string; version: string };

/** The collections published as documentation lines, from the manifest. */
export function collectionsFromManifest(): Collection[] {
  return documentedSoftwareOfKind('collection').map(
    (software: DocumentedSoftware) => ({
      path: software.path,
      package: software.package,
      lines: software.versions.map((entry) => ({
        version: entry.version,
        current: isCurrentLineFolder(entry.folder),
      })),
    }),
  );
}

/** A path with no trailing slash, no query, and no fragment. */
export function normalize(url: string): string {
  const path = url.split(/[#?]/)[0];
  return path.replace(/\/+$/, '') || '/';
}

/**
 * The artifacts a collection publishes above its lines. They name every line
 * by definition, so they belong to none of them.
 */
const NAVIGATIONAL = ['/llms.txt', '/versions.json'];

/**
 * Which line a URL belongs to. A path under a versioned collection carrying a
 * published version segment belongs to that line; one carrying none belongs to
 * the current line, because that is what the version-less paths serve.
 */
export function classifyUrl(url: string, collections: Collection[]): UrlClass {
  const path = normalize(url);
  const collection = collections.find(
    (entry) => path === entry.path || path.startsWith(`${entry.path}/`),
  );
  if (!collection) return { kind: 'unversioned' };

  if (NAVIGATIONAL.some((name) => path === `${collection.path}${name}`)) {
    return { kind: 'unversioned' };
  }

  const segment = path.slice(collection.path.length).split('/')[1] ?? '';
  const explicit = collection.lines.find(
    (line) => line.version === segment && !line.current,
  );
  const line = explicit ?? collection.lines.find((entry) => entry.current);
  if (!line) return { kind: 'unversioned' };

  return { kind: 'line', collection: collection.path, version: line.version };
}

/**
 * Why a reference is not allowed from `scope`, or null when it is.
 *
 * Inside its own collection an artifact may name only its own line. Another
 * versioned collection may be named, but only at its current line: the lines
 * of two collections are cut independently, so nothing pins one release of the
 * SDK to one release of the CLI. Everything unversioned is free.
 *
 * A `scope` of null is an artifact above the lines — the root router, a
 * collection resolver, the site corpus. Naming every line is what those are
 * for, so nothing they reference leaks.
 */
export function leakReason(
  url: string,
  scope: Scope | null,
  collections: Collection[],
): string | null {
  if (!scope) return null;

  const target = classifyUrl(url, collections);
  if (target.kind === 'unversioned') return null;

  if (target.collection === scope.collection) {
    return target.version === scope.version
      ? null
      : `belongs to line ${target.version} of ${target.collection}`;
  }

  const current = collections
    .find((entry) => entry.path === target.collection)
    ?.lines.find((line) => line.current);
  if (current && target.version === current.version) return null;

  return `belongs to line ${target.version} of ${target.collection}, which is not that collection's current line`;
}

/** Extensions a URL may legitimately end on, kept when trimming punctuation. */
const EXTENSIONS = ['.md', '.txt', '.json', '.html', '.png'];

/** The site's own origin, so an absolute link reads as the path it is. */
export const SITE_ORIGIN = 'https://docs.qvac.tether.io';

/**
 * What may precede a path for it to be one. A path is a reference only when
 * something ends before it: an import specifier (`@qvac/sdk/client`), a
 * repository path (`packages/sdk/dist`), or a domain other than this site's
 * carries a `/sdk` that is not a URL of this site.
 */
const BOUNDARY = /[\w@.\-/]/;

/**
 * Every site-relative URL a text names. `prefixes` is what the site actually
 * publishes at its root, so an absolute path that is not one of those — a
 * shell snippet, a file path, an option flag — is not read as a URL.
 */
export function extractUrls(text: string, prefixes: string[]): string[] {
  const source = text.replaceAll(SITE_ORIGIN, '');

  const found = new Set<string>();
  for (const match of source.matchAll(/\/[A-Za-z0-9][\w./-]*/g)) {
    const before = match.index > 0 ? source[match.index - 1] : '';
    if (BOUNDARY.test(before)) continue;

    const url = trimPunctuation(match[0]);
    if (!prefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))) {
      continue;
    }
    found.add(url);
  }
  return [...found];
}

function trimPunctuation(url: string): string {
  let trimmed = url;
  while (
    /[.,;:)!?]$/.test(trimmed) &&
    !EXTENSIONS.some((extension) => trimmed.endsWith(extension))
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

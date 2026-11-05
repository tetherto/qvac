/**
 * What a page says about where it comes from: its collection, the release it
 * documents, and whether that release is the current one.
 *
 * Derived from the version manifest and the page's location, never from the
 * shape of its URL. The current line's pages carry no version segment, so a
 * reader — or a crawler — cannot tell from the URL alone which release
 * `/sdk/quickstart` describes. Publishing it explicitly is what lets
 * retrieval filter on a line at all.
 *
 * One derivation feeds every surface that states it: the front matter of the
 * page's Markdown, the `inkeep:*` meta tags the search index reads, and the
 * build gate that checks the two against the route.
 */

import { collectionTabs } from '@/lib/custom-tree';
import {
  getVersionForPath,
  isCurrentLineFolder,
  isVersionedCollectionPath,
} from '@/lib/versions';

export interface PageAttributes {
  /** The collection's display name, as the collection bar writes it. */
  collection?: string;
  /** The package the collection tracks, for a versioned collection. */
  package?: string;
  /** The documentation line, absent for a collection publishing none. */
  line?: string;
  /** Whether that line is the one served at the version-less paths. */
  currentLine?: boolean;
}

/** The collections that publish no documentation lines. */
export function unversionedCollections(): string[] {
  return collectionTabs
    .filter((tab) => !isVersionedCollectionPath(tab.url))
    .map((tab) => tab.title);
}

/** The collection a URL belongs to, by its display name. */
export function collectionOf(url: string): string | undefined {
  return collectionTabs.find(
    (tab) => url === tab.url || url.startsWith(`${tab.url}/`),
  )?.title;
}

export function pageAttributes(url: string): PageAttributes {
  const attributes: PageAttributes = { collection: collectionOf(url) };

  // Only a collection published as documentation lines has one. An inventory
  // package under Ecosystem carries versions of its own, but those are
  // releases catalogued page by page, not lines of documentation, and
  // retrieval must not scope a reader to one of them.
  const versioned = getVersionForPath(url);
  if (versioned && versioned.software.kind === 'collection') {
    attributes.package = versioned.software.package;
    attributes.line = versioned.version.version;
    attributes.currentLine = isCurrentLineFolder(versioned.version.folder);
  }

  return attributes;
}

/**
 * The attributes as Inkeep ingests them: `inkeep:`-prefixed meta tags in the
 * page head, which the crawler turns into the record attributes that
 * `filters.attributes` matches on.
 *
 * @see https://docs.inkeep.com/cloud/ui-components/customization-guides/filters
 */
export function inkeepMetaTags(url: string): Record<string, string> {
  const { collection, package: pkg, line, currentLine } = pageAttributes(url);

  const tags: Record<string, string> = {};
  if (collection) tags['inkeep:collection'] = collection;
  if (pkg) tags['inkeep:package'] = pkg;
  if (line) tags['inkeep:line'] = line;
  if (currentLine !== undefined) {
    tags['inkeep:current_line'] = String(currentLine);
  }
  return tags;
}

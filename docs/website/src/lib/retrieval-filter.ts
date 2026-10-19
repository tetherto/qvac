/**
 * The attribute filter Search and the AI Assistant send with every query, so
 * a reader inside one documentation line is never answered from another.
 *
 * Enforced by retrieval rather than by ranking: the filter travels on the
 * request, and Inkeep matches it against the `inkeep:*` attributes each page
 * publishes (see `page-attributes.ts`). Ranking would still let a page of
 * another release surface, which is the failure this exists to prevent.
 *
 * What passes, from anywhere:
 *
 *   - the reader's own line, when the reader is inside one;
 *   - the current line of every other versioned collection, mirroring how a
 *     line's pages and artifacts may reference another collection — the two
 *     are cut independently, so nothing pins one release of the SDK to one
 *     release of the CLI;
 *   - every collection that publishes no lines.
 *
 * Outside any line — Ecosystem, Resources, the site root — the reader has no
 * line of their own, so every versioned collection contributes its current
 * one. An older line is then not merely ranked lower; it is not retrieved,
 * which is what "unscoped queries favour the current line" comes to in a
 * filter. The switcher remains the way into an older line.
 *
 * A current line is admitted by its `current_line` flag, never by its version,
 * because a cut changes that version while the URLs it applies to do not: the
 * outgoing line's pages keep answering at the version-less paths until the
 * crawler returns. Naming the version would ask the index for a line no record
 * carries yet, and since the filter is enforced by retrieval, the collection
 * would answer nothing at all until the next crawl. Matching the flag makes a
 * cut cost freshness instead — the previous line answers for that window.
 * A reader who pinned an older line is still matched by version, which is
 * what pinning means.
 *
 * @see https://docs.inkeep.com/cloud/ui-components/customization-guides/filters
 */

import {
  collectionOf,
  unversionedCollections,
} from '@/lib/page-attributes';
import {
  documentedSoftwareOfKind,
  getCurrentLine,
  getVersionForPath,
  isCurrentLineFolder,
  versionOfFolder,
} from '@/lib/versions';

/** The clauses of the filter, in the MongoDB-style shape Inkeep matches on. */
type Match = { $in: string[] };
/**
 * Which line of a collection a clause admits: the current one by its flag, an
 * older one by its version.
 */
type LineMatch = { line: Match } | { current_line: Match };
/** A collection paired with one of its lines, so a line alone matches nothing. */
type LineClause = { $and: [{ collection: Match }, LineMatch] };
/** A whole collection, for the ones that publish no lines. */
type CollectionClause = { collection: Match };
type Clause = LineClause | CollectionClause;

export interface RetrievalFilter {
  attributes: { $or: Clause[] };
}

/** A collection and the one line of it a query may reach. */
export interface AllowedLine {
  collection: string;
  line: string;
  /** Whether that line is the collection's current one. */
  current: boolean;
}

/**
 * Which line of each versioned collection a reader at `pathname` may reach:
 * their own where they are, and the current one everywhere else.
 */
export function allowedLines(pathname: string): AllowedLine[] {
  const readersCollection = collectionOf(pathname);
  const readersLine = getVersionForPath(pathname);
  const readersVersion =
    readersLine?.software.kind === 'collection'
      ? readersLine.version.version
      : null;

  return documentedSoftwareOfKind('collection').flatMap((software) => {
    const collection = collectionOf(software.path);
    if (!collection) return [];

    const current = getCurrentLine(software);
    const currentVersion = current ? versionOfFolder(current.folder) : null;
    const line =
      collection === readersCollection && readersVersion
        ? readersVersion
        : currentVersion;

    if (!line) return [];
    return [{ collection, line, current: line === currentVersion }];
  });
}

/** The filter to send with a query issued from `pathname`. */
export function retrievalFilter(pathname: string): RetrievalFilter {
  const lines = allowedLines(pathname).map(
    ({ collection, line, current }): LineClause => ({
      $and: [
        { collection: { $in: [collection] } },
        // `'true'` because the attribute is a meta tag, so Inkeep holds it as
        // a string; the operator rejects a boolean. See `inkeepMetaTags`.
        current
          ? { current_line: { $in: ['true'] } }
          : { line: { $in: [line] } },
      ],
    }),
  );

  return {
    attributes: {
      $or: [...lines, { collection: { $in: unversionedCollections() } }],
    },
  };
}

/**
 * The line a result URL belongs to, when that line is not the current one.
 * Used to label a result, so a reader inside an older line reads its answers
 * as belonging to that release.
 */
export function lineLabelOf(url: string): string | null {
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
  const versioned = getVersionForPath(path);
  if (!versioned || versioned.software.kind !== 'collection') return null;
  if (isCurrentLineFolder(versioned.version.folder)) return null;
  return versioned.version.version;
}

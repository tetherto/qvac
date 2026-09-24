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
 * Outside any line — Platform, Resources, the site root — the reader has no
 * line of their own, so every versioned collection contributes its current
 * one. An older line is then not merely ranked lower; it is not retrieved,
 * which is what "unscoped queries favour the current line" comes to in a
 * filter. The switcher remains the way into an older line.
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
/** A collection paired with one of its lines, so a version alone matches nothing. */
type LineClause = { $and: [{ collection: Match }, { line: Match }] };
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
    const line =
      collection === readersCollection && readersVersion
        ? readersVersion
        : current
          ? versionOfFolder(current.folder)
          : null;

    return line ? [{ collection, line }] : [];
  });
}

/** The filter to send with a query issued from `pathname`. */
export function retrievalFilter(pathname: string): RetrievalFilter {
  const lines = allowedLines(pathname).map(
    ({ collection, line }): LineClause => ({
      $and: [{ collection: { $in: [collection] } }, { line: { $in: [line] } }],
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

import {
  computeSectionVersionUrl,
  documentedSoftwareOfKind,
  getCurrentLine,
  isCurrentLineFolder,
  versionOfFolder,
} from './versions';

/**
 * What the line switcher needs to know, and the whole of it.
 *
 * The browser is given the published lines of each versioned collection and
 * the pathnames each one holds — no table of a page against its counterparts.
 * Where a switch lands is then a computation over the path the reader is on:
 * the same path under the target line when that line has it, and the line's
 * index when it does not.
 */

export interface Line {
  /**
   * The version this entry publishes, or `null` for one that publishes none —
   * an inventory package's index, which is what its version-less path serves.
   */
  version: string | null;
  /** True for the line served at the collection's version-less paths. */
  current: boolean;
  /** What the switcher shows, the current line marked as such. */
  title: string;
  /** Where the line is entered, and where a switch lands as a fallback. */
  index: string;
  /** Every pathname the line publishes, slash-less as the page tree writes them. */
  urls: string[];
}

export interface CollectionLines {
  /** The collection's URL prefix, without a trailing slash. */
  path: string;
  lines: Line[];
}

/** `v0.17 (latest)` for the current line, `v0.16` for any other. */
export function lineTitle(version: string, current: boolean): string {
  return current ? `${version} (latest)` : version;
}

/** A path with no trailing slash, matching the form `page.url` takes. */
function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/**
 * The lines of every versioned collection, each carrying the pathnames it
 * publishes. `pageUrls` is every URL the site serves, which the caller reads
 * from the loader.
 */
export function collectionLines(pageUrls: string[]): CollectionLines[] {
  const urls = pageUrls.map(normalize);

  return documentedSoftwareOfKind('collection').map((software) => {
    const current = getCurrentLine(software);
    const currentVersion = current ? versionOfFolder(current.folder) : null;

    const lines = software.versions.map((entry): Line => {
      const version = versionOfFolder(entry.folder);
      const isCurrent = isCurrentLineFolder(entry.folder);
      const prefix = isCurrent ? software.path : `${software.path}/${version}`;

      // The current line holds what is left once the other lines have taken
      // theirs: its pages are the ones no version segment claims.
      const others = software.versions
        .filter((other) => !isCurrentLineFolder(other.folder))
        .map((other) => `${software.path}/${versionOfFolder(other.folder)}`);

      return {
        version,
        current: isCurrent,
        title: lineTitle(version, isCurrent),
        index: computeSectionVersionUrl(software.path, version, currentVersion),
        urls: urls.filter((url) => {
          if (url !== prefix && !url.startsWith(`${prefix}/`)) return false;
          if (!isCurrent) return true;
          return !others.some(
            (other) => url === other || url.startsWith(`${other}/`),
          );
        }),
      };
    });

    return { path: software.path, lines };
  });
}

/**
 * What the switcher offers inside an inventory package: the index first, then
 * every version the package publishes.
 *
 * The index is an entry like any other because it is where a package is
 * entered, and a control whose selection is empty renders nothing — without
 * it the switcher would appear only after the reader had already found a
 * version by other means. It is marked `current` in the sense the field
 * carries: it is what the version-less path serves.
 *
 * Read from the manifest alone, with no page list, because a package version
 * publishes exactly one page and the structure check already holds the
 * manifest and the folders to each other.
 */
export function packageLines(): CollectionLines[] {
  return documentedSoftwareOfKind('package').map((software) => ({
    path: software.path,
    lines: [
      {
        version: null,
        current: true,
        title: 'All versions',
        index: software.path,
        urls: [software.path],
      },
      ...software.versions.map((entry): Line => {
        const version = versionOfFolder(entry.folder);
        return {
          version,
          current: false,
          title: version,
          index: computeSectionVersionUrl(software.path, version, null),
          urls: [`${software.path}/${version}`],
        };
      }),
    ],
  }));
}

/** The collection the reader is in, or null outside a versioned one. */
export function collectionOfPath(
  collections: CollectionLines[],
  pathname: string,
): CollectionLines | null {
  const path = normalize(pathname);
  return (
    collections.find(
      (collection) =>
        path === collection.path || path.startsWith(`${collection.path}/`),
    ) ?? null
  );
}

/**
 * Where each line of the collection takes the reader from `pathname`: the
 * same position within that line, or the line's index when the line does not
 * publish that page.
 */
export function destinationsFor(
  collection: CollectionLines,
  pathname: string,
): Array<{ line: Line; url: string }> {
  const path = normalize(pathname);
  const tail = path.slice(collection.path.length);
  const claimed = collection.lines.find(
    (line) =>
      line.version !== null &&
      (tail === `/${line.version}` || tail.startsWith(`/${line.version}/`)),
  );
  const rest = claimed ? tail.slice(`/${claimed.version}`.length) : tail;

  return collection.lines.map((line) => {
    const prefix = line.current
      ? collection.path
      : `${collection.path}/${line.version}`;
    const candidate = `${prefix}${rest}`;

    return {
      line,
      url: line.urls.includes(candidate) ? candidate : line.index,
    };
  });
}

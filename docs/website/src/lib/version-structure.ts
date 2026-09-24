import {
  DOCUMENTED_SOFTWARE,
  isCurrentLineFolder,
  versionOfFolder,
  type DocumentedSoftware,
} from '@/lib/versions';

/**
 * The structure check: the manifest declares which versions exist, the
 * content folders realize them, and this is what refuses to let the two
 * disagree.
 *
 * It is a bijection in both directions. A folder cannot publish itself by
 * being created, and an entry cannot publish a version that has no content —
 * which is what makes a half-done cut a build failure instead of a site that
 * serves an older line as if it were current.
 *
 * Reading the filesystem is left to the caller so the rules can be exercised
 * against inputs that do not exist on disk.
 */

/** What sits directly under a software's content folder. */
export interface DirectoryListing {
  directories: readonly string[];
  /** Content files, `.mdx` or `.md`. */
  files: readonly string[];
}

/** A version folder carrying a patch, which no version folder may. */
const PATCH_SHAPED = /^v\d+\.\d+\..+$/;

/** The shape every version folder has, group or not. */
const VERSION_SHAPED = /^\(?v\d+\.\d+\)?$/;

/**
 * Report everything wrong with the correspondence between the manifest and
 * the folders, one message per problem, each naming the software and the
 * version it is about. An empty array means the two agree.
 *
 * `listings` is keyed by the software's documented path; a `null` entry means
 * the folder itself is absent.
 */
export function checkVersionStructure(
  listings: ReadonlyMap<string, DirectoryListing | null>,
  software: readonly DocumentedSoftware[] = DOCUMENTED_SOFTWARE,
): string[] {
  return software.flatMap((entry) =>
    checkSoftware(entry, listings.get(entry.path) ?? null),
  );
}

function checkSoftware(
  software: DocumentedSoftware,
  listing: DirectoryListing | null,
): string[] {
  if (!listing) {
    return [`${software.path}: documented but has no content folder`];
  }

  const problems: string[] = [];
  const versionFolders = listing.directories.filter((directory) =>
    looksLikeVersionFolder(directory),
  );
  const declaredFolders: string[] = software.versions.map(
    (version) => version.folder,
  );

  for (const version of software.versions) {
    if (PATCH_SHAPED.test(version.version)) {
      problems.push(
        `${software.path}: version ${version.version} carries a patch, which a version folder may not`,
      );
    }
    if (versionOfFolder(version.folder) !== version.version) {
      problems.push(
        `${software.path}: version ${version.version} is declared in folder ${version.folder}, which holds a different version`,
      );
    }
    if (!listing.directories.includes(version.folder)) {
      problems.push(
        `${software.path}: version ${version.version} is declared but folder ${version.folder} does not exist`,
      );
    }
  }

  for (const folder of versionFolders) {
    if (PATCH_SHAPED.test(versionOfFolder(folder))) {
      problems.push(
        `${software.path}: folder ${folder} carries a patch, and a version folder is major and minor only`,
      );
      continue;
    }
    if (!declaredFolders.includes(folder)) {
      problems.push(
        `${software.path}: folder ${folder} exists but no manifest entry declares it`,
      );
    }
  }

  if (software.kind === 'collection') {
    problems.push(...checkCollection(software, listing, versionFolders));
  } else {
    problems.push(...checkPackage(software, versionFolders));
  }

  return problems;
}

/**
 * A versioned collection holds nothing but its lines: exactly one of them is
 * the folder group that makes it current, and no page sits outside a line.
 */
function checkCollection(
  software: DocumentedSoftware,
  listing: DirectoryListing,
  versionFolders: readonly string[],
): string[] {
  const problems: string[] = [];
  const groups = versionFolders.filter((folder) => isCurrentLineFolder(folder));

  if (groups.length !== 1) {
    problems.push(
      `${software.path}: a versioned collection has exactly one current line, found ${groups.length}` +
        (groups.length > 1 ? ` (${groups.join(', ')})` : ''),
    );
  }

  const strays = listing.directories.filter(
    (directory) => !looksLikeVersionFolder(directory),
  );
  for (const stray of strays) {
    problems.push(
      `${software.path}: directory ${stray} is not a line folder, so its pages fall outside every line`,
    );
  }

  for (const file of listing.files) {
    problems.push(
      `${software.path}: ${file} sits directly under the collection instead of inside a line`,
    );
  }

  return problems;
}

/** An inventory package addresses every version explicitly, so none is a group. */
function checkPackage(
  software: DocumentedSoftware,
  versionFolders: readonly string[],
): string[] {
  return versionFolders
    .filter((folder) => isCurrentLineFolder(folder))
    .map(
      (folder) =>
        `${software.path}: folder ${folder} is a folder group, which an inventory package may not use`,
    );
}

/**
 * The same correspondence, one level up: an inventory package is entered at an
 * index that lists its versions, and that list is written by hand. A version
 * whose folder and manifest entry both exist is still unreachable if the index
 * never links it — the inventory offers no switcher, so the index is the only
 * way in.
 *
 * `indexes` is keyed by the software's documented path and holds the index
 * page's text, or `null` where the page is missing. Collections are skipped:
 * they are entered through the switcher, not through an index.
 */
export function checkIndexVersions(
  indexes: ReadonlyMap<string, string | null>,
  software: readonly DocumentedSoftware[] = DOCUMENTED_SOFTWARE,
): string[] {
  return software
    .filter((entry) => entry.kind === 'package')
    .flatMap((entry) => checkIndex(entry, indexes.get(entry.path) ?? null));
}

function checkIndex(
  software: DocumentedSoftware,
  text: string | null,
): string[] {
  if (text === null) {
    return [`${software.path}: has no index page, so its versions cannot be reached`];
  }

  const linked = linkedVersions(software.path, text);
  const declared: string[] = software.versions.map((version) => version.version);

  return [
    ...declared
      .filter((version) => !linked.has(version))
      .map(
        (version) =>
          `${software.path}: version ${version} is declared but the index does not link it`,
      ),
    ...[...linked]
      .filter((version) => !declared.includes(version))
      .map(
        (version) =>
          `${software.path}: the index links version ${version}, which no manifest entry declares`,
      ),
  ];
}

/** The versions of this package an index page links, in either slash form. */
function linkedVersions(path: string, text: string): Set<string> {
  const pattern = new RegExp(`\\]\\(${path}/(v[^/)]+)/?\\)`, 'g');
  return new Set([...text.matchAll(pattern)].map((match) => match[1]));
}

/**
 * Whether a directory name is trying to be a version folder. Patch-shaped
 * names count, so they are reported as malformed rather than ignored as
 * ordinary content.
 */
function looksLikeVersionFolder(directory: string): boolean {
  const inner = versionOfFolder(directory);
  return VERSION_SHAPED.test(directory) || PATCH_SHAPED.test(inner);
}

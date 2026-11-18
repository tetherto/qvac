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
  /**
   * Entries that are symbolic links. The development line is previewed by
   * linking it into its collection, and a link committed by accident would
   * publish an unreleased line in silence: Fumadocs follows it, while the
   * bijection above reads `isDirectory()`, which a link answers `false`. This
   * is the only thing that sees it.
   */
  symlinks?: readonly string[];
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

  for (const link of listing.symlinks ?? []) {
    problems.push(
      `${software.path}: ${link} is a symbolic link, so it publishes whatever ` +
        `it points at without being a line of its own — the preview link ` +
        `belongs in .gitignore, not in a commit`,
    );
  }

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

  problems.push(...checkLines(software, listing, versionFolders));

  return problems;
}

/**
 * A documented software's folder — a product's collection, or a package's
 * folder inside Ecosystem — holds nothing but its lines: exactly one of them
 * is the folder group that makes it current, and no page sits outside a line.
 */
function checkLines(
  software: DocumentedSoftware,
  listing: DirectoryListing,
  versionFolders: readonly string[],
): string[] {
  const problems: string[] = [];
  const groups = versionFolders.filter((folder) => isCurrentLineFolder(folder));

  if (groups.length !== 1) {
    problems.push(
      `${software.path}: a documented software has exactly one current line, found ${groups.length}` +
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

/**
 * Whether a directory name is trying to be a version folder. Patch-shaped
 * names count, so they are reported as malformed rather than ignored as
 * ordinary content.
 */
function looksLikeVersionFolder(directory: string): boolean {
  const inner = versionOfFolder(directory);
  return VERSION_SHAPED.test(directory) || PATCH_SHAPED.test(inner);
}

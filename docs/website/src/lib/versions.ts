/**
 * The version manifest: every piece of software this site documents at more
 * than one version, the package it is, where it is documented, and the
 * versions published for it.
 *
 * Derived, never hand-edited. Each software is declared by one file under
 * `docs/website/versions/` (shape: `versions-file.ts`), which pins every line
 * it publishes to the commit it documents. This module reads those files and
 * presents them in the shape every version-shaped surface consumes — the
 * switcher, the canonicals, `versions.json`, the page metadata, the retrieval
 * filters — so none of them reads the files directly.
 *
 * Currency is read from line order: the first line a file declares is the
 * current one, written as the Fumadocs folder group `(v<major>.<minor>)` so it
 * keeps the collection's version-less paths. Every other line is written
 * `v<major>.<minor>`. A package declares no current version: its version-less
 * path belongs to its index, so none of its folders is a group.
 *
 * Adding a software is adding its versions file and importing it below. A
 * versioned collection also needs its slot in the collection order of
 * `custom-tree.ts`; nothing else in the site names it.
 */
// Relative imports only: this module is part of `source.config.ts`'s import
// graph, which the MDX config loader resolves outside the Next path aliases.
import { parseVersionsFile, type VersionsFile } from './versions-file'
import sdkVersions from '../../versions/sdk.json'
import cliVersions from '../../versions/cli.json'

/** Every versions file, by file name. */
const VERSIONS_FILES: Readonly<Record<string, unknown>> = {
  'sdk.json': sdkVersions,
  'cli.json': cliVersions,
}

/** A documentation line or package version: major and minor, never a patch. */
export type VersionNumber = `v${number}.${number}`;

/** The folder holding a version. Parenthesized when the line is current. */
export type VersionFolder = VersionNumber | `(${VersionNumber})`;

export interface DocumentedVersion {
  version: VersionNumber;
  folder: VersionFolder;
}

/**
 * `user-facing` — software a developer uses directly, with its own versioned
 * root collection publishing a current line and the retained lines before it.
 * `internal-machinery` — a package documented as a sub-collection of
 * Ecosystem → Packages, publishing one folder per retained version with no
 * current version.
 */
export type DocumentedSoftwareKind = 'user-facing' | 'internal-machinery';

export interface DocumentedSoftware {
  /** The name the package publishes under, in its own registry. */
  package: string;
  kind: DocumentedSoftwareKind;
  /** Where it is documented, absolute and without a trailing slash. */
  path: `/${string}`;
  versions: readonly DocumentedVersion[];
  /** Versions no longer published, whose addresses redirect to the current line. */
  retired?: readonly VersionNumber[];
}

/** One versions file parsed and validated, keyed by its file name. */
export interface DeclaredSoftware {
  file: string;
  declaration: VersionsFile;
}

/** Every versions file, parsed. Throws, naming the file, on a malformed one. */
export function declaredSoftware(
  files: Readonly<Record<string, unknown>> = VERSIONS_FILES,
): readonly DeclaredSoftware[] {
  return Object.entries(files).map(([file, raw]) => ({
    file,
    declaration: parseVersionsFile(file, raw),
  }));
}

/** The manifest entry a versions file stands for. */
export function toDocumentedSoftware(declaration: VersionsFile): DocumentedSoftware {
  return {
    package: declaration.package,
    kind: declaration.kind,
    path: declaration.path as `/${string}`,
    versions: declaration.lines.map((line, index): DocumentedVersion => {
      const version = line.version as VersionNumber;
      const current = declaration.kind === 'user-facing' && index === 0;
      return { version, folder: current ? `(${version})` : version };
    }),
    retired: declaration.retired as VersionNumber[],
  };
}

/**
 * Every software the site documents at more than one version, in the order
 * the versions files are listed above.
 */
export const DOCUMENTED_SOFTWARE: readonly DocumentedSoftware[] =
  declaredSoftware().map(({ declaration }) => toDocumentedSoftware(declaration));

/** True when the folder is written as a Fumadocs folder group. */
export function isCurrentLineFolder(folder: string): boolean {
  return folder.startsWith('(') && folder.endsWith(')');
}

/** The version a folder holds, whether or not the folder is a group. */
export function versionOfFolder(folder: string): string {
  return isCurrentLineFolder(folder) ? folder.slice(1, -1) : folder;
}

/** Every documented software of the given kind. */
export function documentedSoftwareOfKind(
  kind: DocumentedSoftwareKind,
): readonly DocumentedSoftware[] {
  return DOCUMENTED_SOFTWARE.filter((software) => software.kind === kind);
}

/**
 * The software documented at the given pathname, or `null` when the pathname
 * documents none. The longest matching path wins, so an inventory package
 * inside Ecosystem resolves to the package rather than to Ecosystem.
 */
export function getDocumentedSoftware(
  pathname: string,
): DocumentedSoftware | null {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const matches = DOCUMENTED_SOFTWARE.filter(
    (software) =>
      normalized === software.path ||
      normalized.startsWith(software.path + '/'),
  );
  if (matches.length === 0) return null;
  return matches.reduce((longest, software) =>
    software.path.length > longest.path.length ? software : longest,
  );
}

/** The versions published for a software, in the order the manifest lists. */
export function getPublishedVersions(
  software: DocumentedSoftware,
): readonly DocumentedVersion[] {
  return software.versions;
}

/**
 * The current line of a versioned collection: the entry whose folder is a
 * group. `null` for an inventory package, which declares no current version.
 */
export function getCurrentLine(
  software: DocumentedSoftware,
): DocumentedVersion | null {
  return (
    software.versions.find((entry) => isCurrentLineFolder(entry.folder)) ?? null
  );
}

/**
 * The version a page belongs to, read from its URL. A path carrying a version
 * segment resolves to that version; a path without one resolves to the current
 * line, which is why only a versioned collection can answer it.
 */
export function getVersionForPath(pathname: string): {
  software: DocumentedSoftware;
  version: DocumentedVersion;
} | null {
  const software = getDocumentedSoftware(pathname);
  if (!software) return null;

  const normalized = pathname.replace(/\/+$/, '') || '/';
  const tail = normalized.slice(software.path.length).replace(/^\/+/, '');
  const segment = tail.split('/')[0];

  const explicit = software.versions.find(
    (entry) => entry.version === segment && !isCurrentLineFolder(entry.folder),
  );
  if (explicit) return { software, version: explicit };

  const current = getCurrentLine(software);
  return current ? { software, version: current } : null;
}

/** True when the pathname falls inside a collection published as lines. */
export function isVersionedCollectionPath(pathname: string): boolean {
  return getDocumentedSoftware(pathname)?.kind === 'user-facing';
}

/**
 * Build the URL for a version of something published at `basePath`. The
 * version served without a segment — a collection's current line — maps to
 * `basePath/`; every other version maps to `basePath/<version>/`. Pass
 * `null` as `versionlessVersion` where no version is served bare, which is
 * every inventory package.
 *
 * Trailing slash is mandatory: versioned slugs contain dots, and Sevalla's
 * Pretty URLs treats a slash-less dotted final segment as a file request and
 * 404s it before `_redirects` runs, so the slash-less→with-slash
 * normalization never fires for them. Emitting the trailing-slash form
 * directly lands on the `200` rewrite (see `public/_redirects`).
 */
export function computeSectionVersionUrl(
  basePath: string,
  targetVersion: string,
  versionlessVersion: string | null,
): string {
  if (versionlessVersion !== null && targetVersion === versionlessVersion) {
    return `${basePath}/`;
  }
  return `${basePath}/${targetVersion}/`;
}

/**
 * The version of the software a collection tracks, as its current line
 * publishes it. `null` for anything the manifest does not document as a
 * collection.
 */
export function getCurrentVersionOf(path: string): string | null {
  const software = getDocumentedSoftware(path);
  if (!software || software.kind !== 'user-facing') return null;
  const current = getCurrentLine(software);
  return current ? versionOfFolder(current.folder) : null;
}

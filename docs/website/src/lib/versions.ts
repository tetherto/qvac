/**
 * The version manifest: every piece of software this site documents at more
 * than one version, the package it is, where it is documented, and the
 * versions published for it.
 *
 * Hand-edited. Publishing a version is two edits in one reviewable diff — the
 * folder under `content/docs/`, and the entry here — and the structure check
 * in `tests/line-structure.test.ts` fails the build when the two disagree.
 *
 * A version records its number and the folder holding it, and nothing else.
 * Whether a versioned collection's line is the current one is read from the
 * folder: the current line is written `(v0.19)`, a Fumadocs folder group
 * excluded from the slug, and every other line `v0.18`. Currency is therefore
 * stated once, in the one place that also determines the URLs.
 *
 * Inventory packages declare no current version. Their version-less path
 * belongs to the package index, so every README sits at a versioned path and
 * no folder group appears anywhere in the inventory.
 */

/** A documentation line or package version: major and minor, never a patch. */
export type VersionNumber = `v${number}.${number}`;

/** The folder holding a version. Parenthesized when the line is current. */
export type VersionFolder = VersionNumber | `(${VersionNumber})`;

export interface DocumentedVersion {
  version: VersionNumber;
  folder: VersionFolder;
}

/**
 * `collection` — a product collection versioned as a whole, publishing one
 * current line and one older line. `package` — an inventory entry publishing
 * one page per release, with no current version.
 */
export type DocumentedSoftwareKind = 'collection' | 'package';

export interface DocumentedSoftware {
  /** The name the package publishes under, in its own registry. */
  package: string;
  kind: DocumentedSoftwareKind;
  /** Where it is documented, absolute and without a trailing slash. */
  path: `/${string}`;
  versions: readonly DocumentedVersion[];
}

/**
 * The SDK collection tracks `@qvac/sdk` and the Provider collection tracks
 * `@qvac/cli`, which implements the OpenAI-compatible HTTP server it
 * documents.
 *
 * The inventory publishes the two most recent releases of each package. The
 * Python client carries no version of its own — `pyproject.toml` stamps it
 * from `packages/sdk/package.json` — so it takes the SDK's numbers.
 */
export const DOCUMENTED_SOFTWARE = [
  {
    package: '@qvac/sdk',
    kind: 'collection',
    path: '/sdk',
    versions: [
      { version: 'v0.19', folder: '(v0.19)' },
      { version: 'v0.18', folder: 'v0.18' },
    ],
  },
  {
    package: '@qvac/cli',
    kind: 'collection',
    path: '/provider',
    versions: [
      { version: 'v0.13', folder: '(v0.13)' },
      { version: 'v0.12', folder: 'v0.12' },
    ],
  },
  {
    package: '@qvac/sdk',
    kind: 'package',
    path: '/platform/inventory/sdk',
    versions: [
      { version: 'v0.19', folder: 'v0.19' },
      { version: 'v0.18', folder: 'v0.18' },
    ],
  },
  {
    package: 'tetherto-qvac-sdk',
    kind: 'package',
    path: '/platform/inventory/sdk-python',
    versions: [
      { version: 'v0.19', folder: 'v0.19' },
      { version: 'v0.18', folder: 'v0.18' },
    ],
  },
  {
    package: '@qvac/cli',
    kind: 'package',
    path: '/platform/inventory/cli',
    versions: [
      { version: 'v0.13', folder: 'v0.13' },
      { version: 'v0.12', folder: 'v0.12' },
    ],
  },
  {
    package: '@qvac/ai-sdk-provider',
    kind: 'package',
    path: '/platform/inventory/ai-sdk-provider',
    versions: [
      { version: 'v0.7', folder: 'v0.7' },
      { version: 'v0.6', folder: 'v0.6' },
    ],
  },
] as const satisfies readonly DocumentedSoftware[];

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
 * inside Platform resolves to the package rather than to Platform.
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
  return getDocumentedSoftware(pathname)?.kind === 'collection';
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
  if (!software || software.kind !== 'collection') return null;
  const current = getCurrentLine(software);
  return current ? versionOfFolder(current.folder) : null;
}

export interface Version {
  label: string;
  value: string;
  isLatest?: boolean;
}

export const VERSIONS: Version[] = [
  { label: 'v0.7.0 (latest)', value: 'v0.7.0', isLatest: true },
];

export const LATEST_VERSION = 'v0.7.0';

const VERSION_PREFIX_RE = /^\/(v\d+\.\d+\.\d+)(\/|$)/;

/**
 * Extract the version prefix from a URL pathname.
 * Returns null when on the (latest) version (no prefix in the URL).
 * @example getVersionFromPath('/v0.6.1/sdk/quickstart') → 'v0.6.1'
 * @example getVersionFromPath('/sdk/quickstart')         → null
 */
export function getVersionFromPath(pathname: string): string | null {
  return pathname.match(VERSION_PREFIX_RE)?.[1] ?? null;
}

/**
 * Compute the equivalent URL for a different version.
 *
 * - latest → latest (no-op)
 * - latest → v0.6.1: prepend /v0.6.1
 * - v0.6.1 → latest: strip /v0.6.1
 * - v0.6.1 → v0.7.0: replace /v0.6.1 with /v0.7.0
 */
export function computeVersionedUrl(
  pathname: string,
  targetVersion: string,
): string {
  const currentVersion = getVersionFromPath(pathname);
  const targetIsLatest = VERSIONS.find(
    (v) => v.value === targetVersion,
  )?.isLatest;

  if (currentVersion) {
    if (targetIsLatest) {
      return pathname.replace(`/${currentVersion}`, '') || '/';
    }
    return pathname.replace(`/${currentVersion}`, `/${targetVersion}`);
  }

  if (targetIsLatest) return pathname;
  return `/${targetVersion}${pathname}`;
}

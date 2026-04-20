export interface Version {
  label: string;
  value: string;
  isLatest?: boolean;
  isDev?: boolean;
}

export const VERSIONS: Version[] = [
  { label: 'dev', value: 'dev', isDev: true },
  { label: 'latest (v0.9.0)', value: 'v0.9.0', isLatest: true },
  { label: 'v0.8.0', value: 'v0.8.0' },
  { label: 'v0.7.0', value: 'v0.7.0' },
];

export const LATEST_VERSION = 'v0.9.0';

const VERSION_PREFIX_RE = /^\/(v\d+\.\d+\.\d+|dev)(\/|$)/;

/**
 * Extract the version prefix from a URL pathname.
 * Returns null when on the (latest) version (no prefix in the URL).
 * @example getVersionFromPath('/v0.6.1/sdk/quickstart') → 'v0.6.1'
 * @example getVersionFromPath('/dev/sdk/api')           → 'dev'
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
 * - latest → dev: prepend /dev
 * - dev → latest: strip /dev
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

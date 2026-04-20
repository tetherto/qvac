import type { Metadata } from 'next';

/**
 * Whether the static export should declare `robots: index` in HTML.
 * Defaults to **noindex** so crawlers that never run JavaScript still omit
 * preview, PR, and local builds.
 *
 * Enable indexing only for the deploy that serves `https://docs.qvac.tether.io`.
 * On Sevalla, set **`DOCS_ALLOW_INDEXING=1`** for that application at **build time**
 * (Next reads this when generating static metadata).
 *
 * Optional: `DOCS_FORCE_NOINDEX=1` forces noindex even when `DOCS_ALLOW_INDEXING` is set.
 */
export function allowDocsIndexingAtBuildTime() {
  if (process.env.DOCS_FORCE_NOINDEX === '1' || process.env.DOCS_FORCE_NOINDEX === 'true') {
    return false;
  }
  return process.env.DOCS_ALLOW_INDEXING === '1' || process.env.DOCS_ALLOW_INDEXING === 'true';
}

export function docsRootMetadataRobots(): Metadata['robots'] {
  return allowDocsIndexingAtBuildTime()
    ? { index: true, follow: true }
    : { index: false, follow: false };
}

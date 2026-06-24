import type { Metadata } from 'next';

/**
 * Whether the static export should declare `robots: index` in HTML.
 * Defaults to **noindex** so crawlers that never run JavaScript still omit
 * preview, PR, and local builds.
 *
 * Enable indexing only for the deploy that serves `https://docs.qvac.tether.io`.
 * On Sevalla, set **`DOCS_ALLOW_INDEXING=true`** for that application at **build
 * time** (Next reads this when generating static metadata). Case-insensitive;
 * any other value (including `1`) is treated as false.
 */
export function allowDocsIndexingAtBuildTime() {
  return process.env.DOCS_ALLOW_INDEXING?.toLowerCase() === 'true';
}

export function docsRootMetadataRobots(): Metadata['robots'] {
  return allowDocsIndexingAtBuildTime()
    ? { index: true, follow: true }
    : { index: false, follow: false };
}

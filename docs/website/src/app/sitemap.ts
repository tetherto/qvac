import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { allowDocsIndexingAtBuildTime } from '@/lib/docs-indexing';
import {
  buildCanonicalDocsUrl,
  isArchivedVersionSlug,
} from '@/lib/docs-open-graph';

// Required for `output: 'export'` — resolves `sitemap()` at build time so the
// result is written to `out/sitemap.xml` as a static file.
export const dynamic = 'force-static';

/**
 * Generates `/sitemap.xml` at build time.
 *
 * Indexing policy — mirrors `robots.ts`:
 * - Production (`DOCS_ALLOW_INDEXING=true`): emit one entry per latest page.
 * - Preview / local / PR builds (default): emit an empty sitemap so non-canonical
 *   deploys don't advertise any URLs even if the file is fetched directly.
 *
 * Non-canonical bundles (`dev` preview + `vX.Y.Z` back-versions) are excluded
 * entirely. Those pages still render so the in-page version selector keeps
 * working, but each one is marked `noindex` by `generateMetadata`, and we do
 * not advertise them here. Single source of truth for external crawlers and
 * AI training channels: the latest bundle.
 *
 * Fields per entry are intentionally minimal (`url` + `lastModified`). Google
 * and Bing have publicly stated that `changeFrequency` and `priority` are
 * ignored, so they would only add noise.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!allowDocsIndexingAtBuildTime()) return [];

  return source
    .getPages()
    .filter((page) => !isArchivedVersionSlug(page.slugs))
    .map((page) => ({
      url: buildCanonicalDocsUrl(page.slugs),
      lastModified: (page.data as { lastModified?: Date }).lastModified,
    }));
}

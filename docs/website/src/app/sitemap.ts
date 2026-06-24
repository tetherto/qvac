import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { allowDocsIndexingAtBuildTime } from '@/lib/docs-indexing';
import {
  DOCS_SITE_ORIGIN,
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
 * - Preview / local / PR builds (default): emit a semantically-empty sitemap
 *   (two duplicate entries for the canonical site root) so non-canonical
 *   deploys don't advertise any internal URL even if the file is fetched
 *   directly. See the in-function comment for why two entries (and not zero
 *   or one) are required.
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
  if (!allowDocsIndexingAtBuildTime()) {
    // Non-canonical deploys (preview / PR / staging): we don't want to
    // advertise any internal URL, but the post-build link checker
    // (`@vahor/next-broken-links`, invoked from `package.json`) parses
    // `out/sitemap.xml` with fast-xml-parser default settings and crashes
    // when `<urlset>` has zero `<url>` children — `urlset.url` is
    // `undefined`, and its `for (... of urlset.url)` then throws
    // `TypeError: x.urlset.url is not iterable`.
    //
    // Emitting two duplicate entries for the canonical site root is
    // semantically equivalent to "empty" for crawlers (the homepage is
    // implicit by visiting the deploy at all, and identical entries are
    // deduplicated) while forcing fast-xml-parser to materialize
    // `urlset.url` as an array — it only coerces to an array when there
    // are 2+ children; a single child becomes an object, which is also
    // not iterable. Verified empirically against fast-xml-parser 5.5.9.
    const root = `${DOCS_SITE_ORIGIN}/`;
    return [{ url: root }, { url: root }];
  }

  return source
    .getPages()
    .filter((page) => !isArchivedVersionSlug(page.slugs))
    .map((page) => ({
      url: buildCanonicalDocsUrl(page.slugs),
      lastModified: (page.data as { lastModified?: Date }).lastModified,
    }));
}

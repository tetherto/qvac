import type { MetadataRoute } from 'next';
import { allowDocsIndexingAtBuildTime } from '@/lib/docs-indexing';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

// Required for `output: 'export'` — resolves `robots()` at build time so the
// result is written to `out/robots.txt` as a static file.
export const dynamic = 'force-static';

/**
 * Generates `/robots.txt` at build time.
 *
 * Indexing policy (allow all) — complements `docsRootMetadataRobots()` in `layout.tsx`:
 * - Production (`DOCS_ALLOW_INDEXING=1`): permissive for all crawlers, including AI
 *   training bots. Declares the sitemap so crawlers can discover the page inventory.
 * - Preview / local / PR builds (default): disallow everything so non-canonical
 *   deploys stay out of search indexes.
 *
 * Per-user-agent rules are intentionally omitted while the policy is "allow all" —
 * the wildcard `User-agent: *` already covers every crawler. Add explicit rules
 * only if the policy needs to diverge per crawler in the future.
 */
export default function robots(): MetadataRoute.Robots {
  if (!allowDocsIndexingAtBuildTime()) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    };
  }

  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${DOCS_SITE_ORIGIN}/sitemap.xml`,
  };
}

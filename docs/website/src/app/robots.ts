import type { MetadataRoute } from 'next';
import { allowDocsIndexingAtBuildTime } from '@/lib/docs-indexing';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

// Required for `output: 'export'` — resolves `robots()` at build time so the
// result is written to `out/robots.txt` as a static file.
export const dynamic = 'force-static';

/**
 * AI crawler user agents that receive an explicit per-User-agent block in
 * production `robots.txt`. Listed per RFC 9309 guidance so consent is
 * unambiguous on a per-crawler basis instead of being implied by `User-agent: *`.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9309
 */
export const AI_BOT_USER_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'Claude-Web',
  'Google-Extended',
  'Amazonbot',
  'anthropic-ai',
  'Bytespider',
  'CCBot',
  'Applebot-Extended',
] as const;

/**
 * Generates `/robots.txt` at build time.
 *
 * Indexing policy (allow all) — complements `docsRootMetadataRobots()` in `layout.tsx`:
 * - Production (`DOCS_ALLOW_INDEXING=true`): permissive for all crawlers. The
 *   wildcard `User-agent: *` declares allow-all, then each AI crawler in
 *   `AI_BOT_USER_AGENTS` gets an explicit block with `Allow: /` per RFC 9309,
 *   so consent for AI training/search bots is stated per-agent rather than
 *   implied. The sitemap is declared so crawlers can discover the page inventory.
 * - Preview / local / PR builds (default): a single wildcard `Disallow: /` keeps
 *   non-canonical deploys out of search and AI indexes. Per-bot blocks are
 *   intentionally omitted here — nothing is indexed and the wildcard already
 *   covers every crawler.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9309
 */
export default function robots(): MetadataRoute.Robots {
  if (!allowDocsIndexingAtBuildTime()) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    };
  }

  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...AI_BOT_USER_AGENTS.map(userAgent => ({ userAgent, allow: '/' })),
    ],
    sitemap: `${DOCS_SITE_ORIGIN}/sitemap.xml`,
  };
}

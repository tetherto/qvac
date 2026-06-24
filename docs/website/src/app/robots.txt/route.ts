import { allowDocsIndexingAtBuildTime } from '@/lib/docs-indexing';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

// Required for `output: 'export'` — resolves the response at build time so the
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
 * Content Signals directive declaring permissive content usage preferences
 * (search indexing, AI input/grounding, and AI training are all allowed).
 * Mirrors the allow-all robots policy.
 *
 * @see https://contentsignals.org/
 * @see https://datatracker.ietf.org/doc/draft-romm-aipref-contentsignals/
 */
const CONTENT_SIGNAL = 'Content-Signal: ai-train=yes, search=yes, ai-input=yes';

function buildUserAgentBlock(userAgent: string): string {
  return `User-agent: ${userAgent}\n${CONTENT_SIGNAL}\nAllow: /`;
}

/**
 * Generates `/robots.txt` at build time as a plain-text response.
 *
 * Implemented as an App Router Route Handler (instead of the Next
 * `MetadataRoute.Robots` helper) because the helper's schema is closed and
 * cannot emit custom directives like `Content-Signal:`.
 *
 * Indexing policy (allow all) — complements `docsRootMetadataRobots()` in
 * `layout.tsx`:
 * - Production (`DOCS_ALLOW_INDEXING=true`): permissive for all crawlers. The
 *   wildcard `User-agent: *` plus each AI crawler in `AI_BOT_USER_AGENTS` get
 *   their own block per RFC 9309. Each block carries `Content-Signal:
 *   ai-train=yes, search=yes, ai-input=yes` and `Allow: /`. The sitemap is
 *   declared at the bottom so crawlers can discover the page inventory.
 *
 *   `Content-Signal:` is repeated in every block because per RFC 9309 §2.2.1
 *   a crawler obeys the most specific matching User-agent group only — it
 *   does not fall back to the wildcard for additional directives. Without
 *   per-block repetition, AI bots that match their own explicit block would
 *   never see the signal.
 * - Preview / local / PR builds (default): a single wildcard `Disallow: /`
 *   keeps non-canonical deploys out of search and AI indexes. Per-bot blocks
 *   and Content-Signal are intentionally omitted — nothing is indexed and the
 *   wildcard already covers every crawler.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9309
 * @see https://contentsignals.org/
 */
export function GET() {
  if (!allowDocsIndexingAtBuildTime()) {
    return new Response('User-agent: *\nDisallow: /\n');
  }

  const blocks = ['*', ...AI_BOT_USER_AGENTS].map(buildUserAgentBlock);
  const body = `${blocks.join('\n\n')}\n\nSitemap: ${DOCS_SITE_ORIGIN}/sitemap.xml\n`;
  return new Response(body);
}

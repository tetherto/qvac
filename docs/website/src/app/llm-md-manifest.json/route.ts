import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';

// Resolves the response at build time so the result is written to
// `out/llm-md-manifest.json` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

/**
 * Internal build-time data dump consumed by
 * `scripts/generate-llm-md-files.ts`. Emits one entry per page (including
 * archived versions of indexable sections — see below) with the processed
 * Markdown body; the post-build splitter reads it, writes one `out/<slug>.md`
 * per entry, and then deletes the manifest so it never ships to the CDN.
 *
 * This indirection exists because `output: 'export'` does not support
 * `rewrites()` and Next.js does not allow `.md` as part of a dynamic route
 * segment (e.g. `[[...slug]].md/route.ts` is invalid). A JSON dump consumed
 * by a tiny splitter gives us predictable file naming with no `out/...`
 * staging tree to clean up.
 *
 * Policy — archived pages ARE included
 * ------------------------------------
 * Unlike `sitemap.xml`, `llms.txt`, and `llms-full.txt`, this manifest does
 * not filter out archived pages (`isArchivedPage`). The earlier policy was
 * to suppress every "AI-friendly" representation of archived sections that
 * carry `noindex` + canonical-to-latest (currently `API_SECTION`), but
 * conflating "not in aggregate catalogs" with "no per-page `.md`" hurts UX
 * for two distinct callers:
 *
 * - The in-page "Copy as Markdown" action issues `fetch(`${pageUrl}.md`)`.
 *   When the `.md` is missing the button silently 404s, even though the
 *   HTML page renders fine.
 * - AI agents performing per-page Markdown content negotiation
 *   (`Accept: text/markdown`) get redirected by `public/_redirects` to a
 *   `.md` URL that does not resolve, ending the chain in a broken 404.
 *
 * Per-page `.md` is just an alternate representation of an already-public
 * HTML page (the archive HTML still renders, with `noindex` carrying the
 * SEO signal). It is conceptually different from the aggregate catalogs
 * (`llms.txt` / `llms-full.txt`), which are bulk training-corpus artefacts
 * where excluding archives genuinely reduces cross-version AI ingestion.
 *
 * Net effect of including archived pages here:
 *   - "Copy as Markdown" works on every page that renders HTML.
 *   - Markdown content negotiation in `_redirects` resolves cleanly because
 *     the static `.md` file always exists alongside the static HTML.
 *   - SEO posture is unchanged: archives stay out of `sitemap.xml`, carry
 *     `noindex`, and point their canonical at the latest series.
 *   - Bulk AI training corpus posture is unchanged: archives remain
 *     excluded from `llms.txt` and `llms-full.txt`.
 */
export async function GET() {
  const pages = source.getPages();

  const entries = await Promise.all(
    pages.map(async (page) => ({
      url: page.url,
      slugs: page.slugs,
      content: await getLLMText(page),
    })),
  );

  return new Response(JSON.stringify(entries), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

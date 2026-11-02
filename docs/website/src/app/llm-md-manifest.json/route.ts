import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';

// Resolves the response at build time so the result is written to
// `out/llm-md-manifest.json` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

/**
 * Internal build-time data dump consumed by
 * `scripts/generate-llm-md-files.ts`. Emits one entry per page with the
 * processed Markdown body; the post-build splitter reads it, writes one
 * `out/<slug>.md` per entry, and then deletes the manifest so it never ships
 * to the CDN.
 *
 * This indirection exists because `output: 'export'` does not support
 * `rewrites()` and Next.js does not allow `.md` as part of a dynamic route
 * segment (e.g. `[[...slug]].md/route.ts` is invalid). A JSON dump consumed
 * by a tiny splitter gives us predictable file naming with no `out/...`
 * staging tree to clean up.
 *
 * Every page gets one, with no filtering. The per-page Markdown is an
 * alternate representation of a page that already renders, and two callers
 * depend on it existing wherever the HTML does: the "Copy as Markdown" action
 * fetches `${pageUrl}.md` and 404s silently without it, and the Markdown
 * content negotiation in `public/_redirects` (`Accept: text/markdown`) sends
 * an agent to a URL that has to resolve. That is a different question from
 * what the aggregate corpora carry, which is decided per line in
 * `llms-full.txt`.
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

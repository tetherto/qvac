import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { isArchivedPage } from '@/lib/docs-open-graph';

// Resolves the response at build time so the result is written to
// `out/llm-md-manifest.json` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

/**
 * Internal build-time data dump consumed by
 * `scripts/generate-llm-md-files.ts`. Emits one entry per non-archived page
 * with the processed Markdown body (same format as `llms-full.txt` chunks);
 * the post-build splitter reads it, writes one `out/<slug>.md` per entry,
 * and then deletes the manifest so it never ships to the CDN.
 *
 * This indirection exists because `output: 'export'` does not support
 * `rewrites()` and Next.js does not allow `.md` as part of a dynamic route
 * segment (e.g. `[[...slug]].md/route.ts` is invalid). A JSON dump consumed
 * by a tiny splitter gives us predictable file naming with no `out/...`
 * staging tree to clean up.
 */
export async function GET() {
  const pages = source.getPages().filter((page) => !isArchivedPage(page));

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

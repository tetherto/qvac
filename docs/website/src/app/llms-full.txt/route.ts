import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { isArchivedPage, isReleaseNotesPage } from '@/lib/docs-open-graph';

// Resolves the response at build time so the result is written to
// `out/llms-full.txt` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

/**
 * Generates `/llms-full.txt` at build time.
 *
 * Concatenates the processed Markdown of every non-archived page into a
 * single dump so AI agents can ingest the full documentation in one fetch.
 * Per-section archived versions (`/reference/api/v0.7.0`, etc.) are excluded
 * via `isArchivedPage` so the dump only carries the latest canonical
 * documentation — consistent with `sitemap.xml`, `llms.txt`, and per-page
 * `noindex` metadata.
 *
 * Additionally, the entire release-notes section (`/reference/release-notes`
 * and its archived series) is dropped via `isReleaseNotesPage`. Release notes
 * are historical changelogs whose bulk text inflates the dump's token count
 * and dilutes an agent's reasoning without adding context needed for SDK
 * usage (QVAC-21379). Unlike the archive exclusion above, this is scoped to
 * `llms-full.txt` only: release notes stay indexed in `sitemap.xml`,
 * `llms.txt`, and per-page `.md` so an agent can still fetch a specific
 * release note on demand.
 */
export async function GET() {
  const scan = source
    .getPages()
    .filter((page) => !isArchivedPage(page) && !isReleaseNotesPage(page))
    .map(getLLMText);
  const scanned = await Promise.all(scan);

  return new Response(scanned.join('\n\n'));
}

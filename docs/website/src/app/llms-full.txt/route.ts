import { getLLMText } from '@/lib/get-llm-text';
import { isReleaseNotesPage } from '@/lib/docs-open-graph';
import {
  corpusHeader,
  pagesOfLine,
  unversionedPages,
  versionedCollections,
} from '@/lib/artifacts';

// Resolves the response at build time so the result is written to
// `out/llms-full.txt` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

/**
 * Generates `/llms-full.txt` at build time: everything the site publishes,
 * minus the choices it cannot make for the reader.
 *
 * A versioned collection contributes its current line only. Concatenating two
 * lines of the same collection would put two releases of the same API in one
 * corpus, which is the failure the lines exist to prevent; an agent that needs
 * an older line fetches that line's own corpus, named in the header below.
 *
 * The release notes of every line are dropped. They are historical changelogs
 * whose bulk text inflates the dump's token count and dilutes an agent's
 * reasoning without adding context needed to use the release (QVAC-21379).
 * They stay indexed in `sitemap.xml`, in each line's index, and as per-page
 * Markdown, so a specific release note is still one fetch away.
 */
export async function GET() {
  const collections = versionedCollections();

  const versionedPages = [];
  for (const { lines } of collections) {
    const current = lines.find((line) => line.current);
    if (!current) continue;
    versionedPages.push(...pagesOfLine(current));
  }

  const all = [...unversionedPages(), ...versionedPages];
  const pages = all.filter((page) => !isReleaseNotesPage(page));
  const texts = await Promise.all(pages.map(getLLMText));
  const header = corpusHeader({
    kind: 'site',
    collections,
    pages: pages.length,
    withheld: all.length - pages.length,
  });

  return new Response([header, ...texts].join('\n\n'));
}

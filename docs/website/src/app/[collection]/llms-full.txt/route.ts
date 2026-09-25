import { notFound } from 'next/navigation';
import { getLLMText } from '@/lib/get-llm-text';
import { isReleaseNotesPage } from '@/lib/docs-open-graph';
import {
  corpusHeader,
  pagesOfLine,
  versionedCollection,
  versionedCollections,
} from '@/lib/artifacts';

// Resolves at build time so the corpus is written to
// `out/<collection>/llms-full.txt` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

export function generateStaticParams() {
  return versionedCollections().map((collection) => ({
    collection: collection.path.slice(1),
  }));
}

/**
 * The current line's corpus, at the collection's version-less path — where
 * its content is served. Another line's corpus sits under that line's version
 * segment, in the sibling route.
 *
 * Release notes are left out, as they are from the site-wide corpus: they are
 * historical changelogs whose bulk text inflates the token count without
 * adding context an agent needs to use the release (QVAC-21379). They stay
 * listed in the line's index and fetchable one page at a time.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ collection: string }> },
) {
  const { collection: segment } = await context.params;
  const collection = versionedCollection(`/${segment}`);
  const line = collection?.lines.find((entry) => entry.current);
  if (!collection || !line) notFound();

  const all = pagesOfLine(line);
  const pages = all.filter((page) => !isReleaseNotesPage(page));
  const texts = await Promise.all(pages.map(getLLMText));
  const header = corpusHeader({
    kind: 'line',
    collection,
    line,
    pages: pages.length,
    withheld: all.length - pages.length,
  });

  return new Response([header, ...texts].join('\n\n'));
}

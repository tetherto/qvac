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
// `out/<collection>/<version>/llms-full.txt` as a static file under
// `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

/**
 * Only the lines served under a version segment. The current line's corpus is
 * published by the sibling route at the collection's version-less path, since
 * that is where its content is served.
 */
export function generateStaticParams() {
  return versionedCollections().flatMap((collection) =>
    collection.lines
      .filter((line) => !line.current)
      .map((line) => ({
        collection: collection.path.slice(1),
        line: line.version,
      })),
  );
}

/** One line's pages in full, and no page of any other line. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ collection: string; line: string }> },
) {
  const { collection: segment, line: version } = await context.params;
  const collection = versionedCollection(`/${segment}`);
  const line = collection?.lines.find(
    (entry) => entry.version === version && !entry.current,
  );
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

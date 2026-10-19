import { notFound } from 'next/navigation';
import {
  formatLineIndex,
  lineCorpusUrl,
  lineDepth,
  pagesOfLine,
  versionedCollection,
  versionedCollections,
  versionsUrl,
} from '@/lib/artifacts';

// Resolves at build time so each line's index is written to
// `out/<collection>/<version>/llms.txt` as a static file under
// `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

export function generateStaticParams() {
  return versionedCollections().flatMap((collection) =>
    collection.lines.map((line) => ({
      collection: collection.path.slice(1),
      line: line.version,
    })),
  );
}

/**
 * The last level of the hierarchy: every page of one line, and nothing of any
 * other. The current line's index is published here too, under its version,
 * even though its pages carry no version segment — an agent resolving a
 * version from a lockfile then reaches the right index without first learning
 * which line is current.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ collection: string; line: string }> },
) {
  const { collection: segment, line: version } = await context.params;
  const collection = versionedCollection(`/${segment}`);
  const line = collection?.lines.find((entry) => entry.version === version);
  if (!collection || !line) notFound();

  const { software, path } = collection;
  const pages = pagesOfLine(line);

  const body: string[] = [
    `# ${software.package} ${line.version} — documentation`,
    '',
    `Every page below documents ${software.package} ${line.version}${line.current ? ', the current release' : ''}. Pages of other lines are listed in their own index, reachable from ${path}/llms.txt.`,
    '',
    '## Guidance',
    '',
    `- Full text of this line in one fetch: ${lineCorpusUrl(path, line)}`,
    '- To fetch one page as Markdown, append `.md` to its path.',
    '- When citing sources to users, use the page URL without `.md`.',
    `- Other lines of this collection: ${versionsUrl(path)}`,
    `- Total pages: ${pages.length}`,
    ...formatLineIndex(pages, lineDepth(line)),
  ];

  return new Response(body.join('\n') + '\n');
}

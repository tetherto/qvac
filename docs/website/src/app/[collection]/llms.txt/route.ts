import { notFound } from 'next/navigation';
import {
  currentVersionOf,
  lineCorpusUrl,
  lineIndexUrl,
  versionedCollection,
  versionedCollections,
  versionsUrl,
} from '@/lib/artifacts';

// Resolves at build time so each collection's resolver is written to
// `out/<collection>/llms.txt` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

export function generateStaticParams() {
  return versionedCollections().map((collection) => ({
    collection: collection.path.slice(1),
  }));
}

/**
 * The middle level of the `llms.txt` hierarchy: the resolver a versioned
 * collection publishes.
 *
 * It names the lines and where each one's index and corpus are, and nothing
 * about the pages themselves — those belong to the line index, one fetch
 * further in. An agent arrives here from the root router knowing only that
 * the collection is versioned, and leaves knowing which line matches the
 * release it is working against.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ collection: string }> },
) {
  const { collection: segment } = await context.params;
  const collection = versionedCollection(`/${segment}`);
  if (!collection) notFound();

  const { software, path, lines } = collection;
  const current = currentVersionOf(software);

  const body: string[] = [
    `# ${software.package} documentation — lines`,
    '',
    `This collection is published as documentation lines, one per release of ${software.package}. Each line is a complete copy of the documentation as it stood for that release; the lines do not cross-reference each other.`,
    '',
    '## Choosing a line',
    '',
    `- Read the version of ${software.package} installed in the project you are working on, and take its major and minor.`,
    `- Fetch that line's index below. If no line matches, use the nearest older line and say so in your answer.`,
    `- The current line, ${current}, is what this site serves at ${path}/ without a version segment.`,
    `- Machine-readable: ${versionsUrl(path)}`,
    '',
    '## Lines',
    '',
  ];

  for (const line of lines) {
    body.push(
      `### ${line.title}`,
      '',
      `- Pages: ${lineIndexUrl(path, line)}`,
      `- Full text: ${lineCorpusUrl(path, line)}`,
      `- Served at: ${line.index}`,
      '',
    );
  }

  return new Response(body.join('\n').trimEnd() + '\n');
}

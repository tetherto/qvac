import { notFound } from 'next/navigation';
import {
  lineCorpusUrl,
  lineIndexUrl,
  versionedCollection,
  versionedCollections,
} from '@/lib/artifacts';

// Resolves at build time so each collection's line index is written to
// `out/<collection>/versions.json` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

export function generateStaticParams() {
  return versionedCollections().map((collection) => ({
    collection: collection.path.slice(1),
  }));
}

/**
 * The machine-readable form of what the resolver states in prose.
 *
 * Generated from the version manifest, which the build has already checked
 * against the line folders, so a line appears here by being published and
 * cannot be listed without existing. Nothing in this file is hand-written,
 * which is why cutting a line needs no edit to it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ collection: string }> },
) {
  const { collection: segment } = await context.params;
  const collection = versionedCollection(`/${segment}`);
  if (!collection) notFound();

  const { software, path, lines } = collection;

  const body = {
    package: software.package,
    path,
    lines: lines.map((line) => ({
      version: line.version,
      current: line.current,
      url: line.index,
      index: lineIndexUrl(path, line),
      corpus: lineCorpusUrl(path, line),
    })),
  };

  return new Response(JSON.stringify(body, null, 2) + '\n', {
    headers: { 'Content-Type': 'application/json' },
  });
}

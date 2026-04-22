import { source } from '@/lib/source';
import { LATEST_VERSION } from '@/lib/versions';
import { isArchivedVersionSlug } from '@/lib/docs-open-graph';

export const revalidate = false;

export function GET() {
  // Non-canonical bundles (dev + vX.Y.Z) are excluded so the LLM index
  // only advertises the latest canonical documentation.
  const pages = source
    .getPages()
    .filter((page) => !isArchivedVersionSlug(page.slugs));
  const index = [
    '# QVAC Documentation (llms.txt)',
    '',
    'Agent index for the QVAC documentation website.',
    '',
    '- Full documentation dump: /llms-full.txt',
    '',
    'Guidance:',
    '- Use /llms-full.txt as the primary context for answering questions.',
    '- When answering, reference the most relevant doc page URL(s).',
    `- Latest SDK version: ${LATEST_VERSION}`,
    `- Total pages: ${pages.length}`,
  ].join('\n');

  return new Response(index);
}

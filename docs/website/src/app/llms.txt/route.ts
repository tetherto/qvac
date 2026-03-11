import { source } from '@/lib/source';
import { LATEST_VERSION } from '@/lib/versions';

export const revalidate = false;

export function GET() {
  const pages = source.getPages();
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

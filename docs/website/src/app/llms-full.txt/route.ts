import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { isArchivedVersionSlug } from '@/lib/docs-open-graph';

// cached forever
export const revalidate = false;

export async function GET() {
  // Non-canonical bundles (dev + vX.Y.Z) are excluded so the full LLM dump
  // only contains the latest canonical documentation.
  const scan = source
    .getPages()
    .filter((page) => !isArchivedVersionSlug(page.slugs))
    .map(getLLMText);
  const scanned = await Promise.all(scan);

  return new Response(scanned.join('\n\n'));
}

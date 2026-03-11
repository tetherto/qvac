import { source } from '@/lib/source';
import { getLLMText } from '@/lib/get-llm-text';
import { LATEST_VERSION } from '@/lib/versions';

export const revalidate = false;

const API_VERSION_RE = /^\/docs\/sdk\/api\/(v\d+\.\d+\.\d+)(\/|$)/;

function isNonLatestApiVersion(url: string): boolean {
  const match = API_VERSION_RE.exec(url);
  if (!match) return false;
  return match[1] !== LATEST_VERSION;
}

export async function GET() {
  const pages = source
    .getPages()
    .filter((page) => !isNonLatestApiVersion(page.url));

  const scanned = await Promise.all(pages.map(getLLMText));

  return new Response(scanned.join('\n\n'));
}

import { source } from '@/lib/source';
import { LATEST_VERSION } from '@/lib/versions';
import { isArchivedPage } from '@/lib/docs-open-graph';
import type { InferPageType } from 'fumadocs-core/source';

// Resolves the response at build time so the result is written to
// `out/llms.txt` as a static file under `output: 'export'`.
export const dynamic = 'force-static';
export const revalidate = false;

type Page = InferPageType<typeof source>;

const ROOT_SECTION = '(root)';

/**
 * Generates the `llms.txt` agent index at build time.
 *
 * Format follows the de-facto convention popularized by https://llmstxt.org/:
 * an H1 with the project name, a short paragraph describing the site, a
 * "Guidance" preamble, and one `## Section` per top-level slug whose body is
 * a bullet list of `- [Title](url): description` entries.
 *
 * Archived per-section versions (e.g. `/reference/api/v0.7.0`) are filtered
 * out via `isArchivedPage` so the index advertises only the latest canonical
 * documentation — consistent with `sitemap.xml`, `llms-full.txt`, and the
 * per-page `noindex` metadata.
 */
export function GET() {
  const pages = source
    .getPages()
    .filter((page) => !isArchivedPage(page))
    .sort((a, b) => a.url.localeCompare(b.url));

  const grouped = groupPagesByTopLevelSlug(pages);

  const lines: string[] = [
    '# QVAC Documentation',
    '',
    "Agent index for the QVAC developer documentation. QVAC is Tether's local-first AI SDK for cross-platform, peer-to-peer applications.",
    '',
    '## Guidance',
    '',
    '- To fetch one page as Markdown, append `.md` to its path (e.g. `/quickstart` → `/quickstart.md`). Alternatively, send the HTTP header `Accept: text/markdown` and any page URL will be redirected to its Markdown variant.',
    '- To obtain a dump with all documentation, fetch `/llms-full.txt`.',
    '- When citing sources to users, use the canonical URL without `.md` (e.g. `/quickstart`), not the Markdown variant.',
    `- Latest SDK version: ${LATEST_VERSION}`,
    `- Total pages: ${pages.length}`,
  ];

  for (const section of Object.keys(grouped).sort(compareSections)) {
    lines.push('', `## ${formatSectionTitle(section)}`, '');
    for (const page of grouped[section]) {
      lines.push(formatPageEntry(page));
    }
  }

  return new Response(lines.join('\n') + '\n');
}

function groupPagesByTopLevelSlug(pages: Page[]): Record<string, Page[]> {
  const initial: Record<string, Page[]> = {};
  for (const page of pages) {
    const key = page.slugs[0] ?? ROOT_SECTION;
    (initial[key] ??= []).push(page);
  }

  // Collapse standalone root pages (single-slug, only entry in their group)
  // into the root section so they don't each spawn a one-entry `##` heading.
  // Sections that genuinely have multiple pages (e.g. `cli` with `/cli` and
  // `/cli/http-server`) keep their own heading.
  const collapsed: Record<string, Page[]> = {};
  for (const [key, list] of Object.entries(initial)) {
    if (
      key !== ROOT_SECTION &&
      list.length === 1 &&
      list[0].slugs.length === 1
    ) {
      (collapsed[ROOT_SECTION] ??= []).push(list[0]);
    } else {
      collapsed[key] = list;
    }
  }
  return collapsed;
}

/** Keeps `(root)` first so top-level pages (quickstart, installation, …) lead. */
function compareSections(a: string, b: string): number {
  if (a === ROOT_SECTION) return -1;
  if (b === ROOT_SECTION) return 1;
  return a.localeCompare(b);
}

function formatSectionTitle(key: string): string {
  if (key === ROOT_SECTION) return 'Overview';
  return key
    .split('-')
    .map((part) =>
      part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ');
}

function formatPageEntry(page: Page): string {
  const title = page.data.title;
  const description = page.data.description?.trim();
  const base = `- [${title}](${page.url})`;
  return description ? `${base}: ${description}` : base;
}

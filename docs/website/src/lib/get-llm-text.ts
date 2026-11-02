import { source } from '@/lib/source';
import { buildCanonicalDocsUrl } from '@/lib/docs-open-graph';
import { pageAttributes } from '@/lib/page-attributes';
import { stripMdxComments } from '@/lib/mdx-comments';
import type { InferPageType } from 'fumadocs-core/source';

/**
 * The Markdown the site publishes for a page, with what an agent needs to
 * know about where the page comes from.
 *
 * The metadata is derived from the page's URL, never from its front matter:
 * moving a page into another line changes what its Markdown states, with no
 * edit to the page. A page of a collection that publishes no lines declares
 * no line, which is how an agent tells "this applies to every release" from
 * "this applies to v0.16".
 */
export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = stripMdxComments(await page.data.getText('processed'));
  const front = frontMatter(page);

  return `---
${front.join('\n')}
---

# ${page.data.title} (${page.url})

${processed}`;
}

function frontMatter(page: InferPageType<typeof source>): string[] {
  const fields = [
    `title: ${JSON.stringify(page.data.title)}`,
    `canonical: ${buildCanonicalDocsUrl(page.slugs)}`,
  ];

  const { collection, package: pkg, line, currentLine } = pageAttributes(page.url);
  if (collection) fields.push(`collection: ${JSON.stringify(collection)}`);
  if (pkg) fields.push(`package: ${JSON.stringify(pkg)}`);
  if (line) fields.push(`line: ${line}`);
  if (currentLine !== undefined) fields.push(`current_line: ${currentLine}`);

  return fields;
}

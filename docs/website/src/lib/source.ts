import { docs } from 'fumadocs-mdx:collections/server';
import { loader, type InferPageType } from 'fumadocs-core/source';
import { resolveIcon } from './resolveIcon';

// See https://fumadocs.vercel.app/docs/headless/source-api for more info
export const source = loader({
  // it assigns a URL to your pages
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  // The same resolver `custom-tree.ts` uses, so a name the site can draw in
  // one collection it can draw in every other.
  icon: resolveIcon,
  pageTree: {
    transformers: [
      {
        /**
         * Apply `sidebarTitle`, so a page can read one way in the sidebar and
         * another as a page. Without it the two are the same string, and the
         * label a documentation line declares in its `meta.json` could only be
         * changed by retitling the page.
         */
        file(node, filePath) {
          if (!filePath) return node;
          const file = this.storage.read(filePath);
          if (file?.format !== 'page') return node;
          const { sidebarTitle } = file.data;
          return sidebarTitle ? { ...node, name: sidebarTitle } : node;
        },
      },
    ],
  },
});

/**
 * Open Graph image path for a page. Returns a static asset path when the page
 * defines `ogImage` in frontmatter, otherwise falls back to the dynamic
 * `next/og` route.
 * @see https://www.fumadocs.dev/docs/integrations/og/next
 */
export function getPageImage(page: InferPageType<typeof source>) {
  if (page.data.ogImage) {
    return { url: page.data.ogImage };
  }
  return {
    url: `/og/docs/${[...page.slugs, 'image.png'].join('/')}`,
  };
}


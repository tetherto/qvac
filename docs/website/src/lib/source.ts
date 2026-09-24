import { docs } from 'fumadocs-mdx:collections/server';
import { loader, type InferPageType } from 'fumadocs-core/source';
import { icons } from 'lucide-react';
import { SiElectron, SiExpo, SiPython, SiTypescript } from '@icons-pack/react-simple-icons';
import { createElement } from 'react';

/**
 * Brand icons the tree names, beyond Lucide's set. They are listed here
 * because an icon reaches the tree as a string — written in a page's
 * frontmatter, a `meta.json`, or a separator — and this resolver is the one
 * place that turns such a string into an element.
 */
const brandIcons = { SiElectron, SiExpo, SiPython, SiTypescript };

// See https://fumadocs.vercel.app/docs/headless/source-api for more info
export const source = loader({
  // it assigns a URL to your pages
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  icon(icon) {
    if (!icon) {
      // You may set a default icon
      return;
    }
    if (icon in brandIcons) {
      return createElement(brandIcons[icon as keyof typeof brandIcons], {
        className: 'h-4 w-4',
      });
    }
    if (icon in icons) return createElement(icons[icon as keyof typeof icons]);
  },
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


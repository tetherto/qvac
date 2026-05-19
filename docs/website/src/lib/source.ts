import { docs } from 'fumadocs-mdx:collections/server';
import { loader, type InferPageType } from 'fumadocs-core/source';
import { icons } from 'lucide-react';
import { createElement } from 'react';

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
    if (icon in icons) return createElement(icons[icon as keyof typeof icons]);
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


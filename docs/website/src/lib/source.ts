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
 * Open Graph image path for a page (`next/og` route). Append `image.png` for Fumadocs-style URLs.
 * @see https://www.fumadocs.dev/docs/integrations/og/next
 */
export function getPageImage(page: InferPageType<typeof source>) {
  const isHomePage = page.slugs.length === 0;
  if (isHomePage) {
    return {
      segments: ['home-og.jpg'],
      url: '/home-og.jpg',
    };
  }

  const segments = [...page.slugs, 'image.png'];
  return {
    segments,
    url: `/og/docs/${segments.join('/')}`,
  };
}


import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { getInconsolataOgFonts } from '@/lib/qvac-doc-og-fonts';
import {
  buildQvacDocOgImageElement,
  QVAC_DOC_OG_HEIGHT,
  QVAC_DOC_OG_WIDTH,
} from '@/lib/qvac-doc-og';

export const revalidate = false;

/**
 * Dynamic OG images (title + description) via `next/og`, Fumadocs-style route.
 * @see https://www.fumadocs.dev/docs/integrations/og/next
 */
function ogSlugFromParams(slug: string[]): string[] {
  if (slug.length && slug[slug.length - 1] === 'image.png') {
    return slug.slice(0, -1);
  }
  return slug;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await ctx.params;
  const pageSlug = ogSlugFromParams(slug);
  const page = source.getPage(pageSlug.length ? pageSlug : []);
  if (!page) notFound();

  const [element, fonts] = await Promise.all([
    buildQvacDocOgImageElement({
      title: page.data.title,
      description: page.data.description,
    }),
    getInconsolataOgFonts(),
  ]);

  return new ImageResponse(element, {
    width: QVAC_DOC_OG_WIDTH,
    height: QVAC_DOC_OG_HEIGHT,
    fonts,
  });
}

export async function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: [...page.slugs, 'image.png'],
  }));
}

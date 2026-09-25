import { getPageImage, source } from '@/lib/source';
import {
  DocsBody,
  DocsPage,
  DocsTitle,
  DocsDescription,
} from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/mdx-components';
import { SmartAnchor } from '@/components/mdx-smart-card';
import type { AnchorHTMLAttributes } from "react";
import { CopyPageButton, ViewOptions } from '@/components/page-actions';
import { PageBreadcrumb } from '@/components/page-breadcrumb';
import {
  DOCS_SITE_ORIGIN,
  buildCanonicalDocsUrl,
} from '@/lib/docs-open-graph';
import { buildDocsJsonLd } from '@/lib/docs-json-ld';
import { inkeepMetaTags } from '@/lib/page-attributes';
import { QVAC_DOC_OG_HEIGHT, QVAC_DOC_OG_WIDTH } from '@/lib/qvac-doc-og';

function TitleText({
  title,
  style,
}: {
  title: string;
  style?: "code";
}) {
  if (style === "code") {
    return (
      <span className="fd-title-code font-mono border rounded-md px-2 py-1">
        {title}
      </span>
    );
  }

  return <>{title}</>;
}

export default async function Page(props: PageProps<'/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDXContent = page.data.body;

  // Filter ToC to include H2 through H5 by default. A page can opt into a
  // shallower ToC by setting `tocMaxDepth` in its frontmatter (e.g. `2` to
  // index only H2 headings).
  const tocMaxDepth = page.data.tocMaxDepth ?? 5;
  const filteredToc = page.data.toc?.filter(item => item.depth >= 2 && item.depth <= tocMaxDepth) || [];

  const isHomePage = !params.slug || params.slug.length === 0;
  // Breadcrumb ancestors are resolved against the page tree so folders with
  // no `index.mdx` are collapsed out of the trail instead of emitting a
  // `ListItem` whose URL 404s.
  const jsonLdBlocks = buildDocsJsonLd(
    page,
    params.slug ?? [],
    isHomePage,
    (slugs) => source.getPage(slugs),
  );
  const pageMarkdownUrl = page.url === '/' ? '/index.md' : `${page.url}.md`;

  return (
    <>
      {jsonLdBlocks?.map((block, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block) }}
        />
      ))}
      <DocsPage toc={filteredToc} slots={{ breadcrumb: PageBreadcrumb }} tableOfContent={{ style: "clerk" }} tableOfContentPopover={{ style: "clerk" }} full={page.data.full}>
      <DocsTitle>
        <TitleText title={page.data.title} style={page.data.titleStyle as any} />
      </DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6 -mt-6">
        <CopyPageButton markdownUrl={pageMarkdownUrl} />
        <ViewOptions markdownUrl={pageMarkdownUrl} />
      </div>
      <DocsBody>
        <MDXContent
          components={getMDXComponents({
            // Resolve relative markdown hrefs (e.g. `./foo.mdx`) to
            // their absolute docs URL server-side, then hand off to
            // `SmartAnchor` (a client component) which renders the
            // standard link OUTSIDE a Card and degrades to a styled
            // span INSIDE a Card to avoid nested `<a>` (which would
            // hydrate-mismatch the page). We do the resolution here
            // — not inside `mdx-components.tsx` — because crossing
            // the function as a prop into a client component is
            // forbidden by React Server Components.
            a: ({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
              <SmartAnchor
                href={href ? source.resolveHref(href, page) : href}
                {...rest}
              />
            ),
          })}
        />
      </DocsBody>
    </DocsPage>
    </>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(
  props: PageProps<'/[[...slug]]'>,
): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  const isHomePage = !params.slug || params.slug.length === 0;

  const { title, description } = page.data;
  // A page is canonical for its own line: the version-less URL for a page of
  // the current line, and the versioned URL for a page of any other, so no
  // line points its authority at another. The self-URL is therefore both the
  // canonical and what Open Graph and Twitter carry.
  const selfUrl = buildCanonicalDocsUrl(params.slug);
  const ogImage = getPageImage(page);
  // Mirrors the `Accept: text/markdown` redirect in `_redirects`. Every page
  // ships a `.md` sibling, in every line.
  const markdownAlternateUrl = `${DOCS_SITE_ORIGIN}${page.url === '/' ? '/index.md' : `${page.url}.md`}`;

  return {
    title: isHomePage ? { absolute: title } : title,
    description,
    alternates: {
      canonical: selfUrl,
      types: { 'text/markdown': markdownAlternateUrl },
    },
    openGraph: {
      title,
      description: description ?? undefined,
      url: selfUrl,
      siteName: 'QVAC',
      locale: 'en_US',
      type: isHomePage ? 'website' : 'article',
      images: [
        {
          url: ogImage.url,
          width: QVAC_DOC_OG_WIDTH,
          height: QVAC_DOC_OG_HEIGHT,
          alt: 'QVAC documentation',
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: description ?? undefined,
      images: [ogImage.url],
    },
    // What the search index filters on. Inkeep's crawler reads `inkeep:`
    // meta tags off the page and turns them into record attributes, which is
    // the only way a current-line page can declare the release it documents:
    // its URL carries no version segment to infer one from.
    other: inkeepMetaTags(page.url),
  };
}

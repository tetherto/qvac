import { getPageImage, source } from '@/lib/source';
import {
  DocsBody,
  DocsPage,
  DocsTitle,
  DocsDescription,
} from 'fumadocs-ui/page';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { getMDXComponents } from '@/mdx-components';
import { resolveIcon } from "@/lib/resolveIcon";
import { cloneElement, isValidElement } from "react";
import { CopyPageButton, ViewOptions, VersionSelector } from '@/components/page-actions';
import {
  buildCanonicalDocsUrl,
  buildPageCanonicalUrl,
  isArchivedVersionSlug,
} from '@/lib/docs-open-graph';
import { buildDocsJsonLd } from '@/lib/docs-json-ld';
import { QVAC_DOC_OG_HEIGHT, QVAC_DOC_OG_WIDTH } from '@/lib/qvac-doc-og';
import { getVersionSelectorProps } from '@/lib/versions';

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

  const rawIcon =
  typeof page.data.icon === "string" ? resolveIcon(page.data.icon) : page.data.icon;

  const titleIcon = isValidElement(rawIcon)
    ? cloneElement(rawIcon, {
        size: "1.2em",       // <- slightly larger than a capital letter
        strokeWidth: 1.25,   // <- thinner stroke
        className: "shrink-0",
        "aria-hidden": true,
      })
    : null;

  // Filter ToC to include H2 through H5 by default. A page can opt into a
  // shallower ToC by setting `tocMaxDepth` in its frontmatter (e.g. `2` to
  // index only H2 headings).
  const tocMaxDepth = page.data.tocMaxDepth ?? 5;
  const filteredToc = page.data.toc?.filter(item => item.depth >= 2 && item.depth <= tocMaxDepth) || [];

  const isHomePage = !params.slug || params.slug.length === 0;
  const jsonLdBlocks = buildDocsJsonLd(page, params.slug ?? [], isHomePage);
  const versionSelectorProps = getVersionSelectorProps(params.slug ?? []);
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
      <DocsPage toc={filteredToc} tableOfContent={{ style: "clerk" }} tableOfContentPopover={{ style: "clerk" }} full={page.data.full}>
      <DocsTitle>
        <span className="inline-flex items-center gap-2 leading-none">
          {titleIcon ? (
            // micro-adjustment (very small). Start with 0.02em.
            <span className="inline-flex items-center relative top-[0.02em]">
              {titleIcon}
            </span>
          ) : null}

          <span className="leading-none">
            <TitleText title={page.data.title} style={page.data.titleStyle as any} />
          </span>
        </span>
      </DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6 -mt-6">
        {versionSelectorProps && <VersionSelector {...versionSelectorProps} />}
        <CopyPageButton markdownUrl={pageMarkdownUrl} />
        <ViewOptions markdownUrl={pageMarkdownUrl} />
      </div>
      <DocsBody>
        <MDXContent
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
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
  // Self-URL of the page. Used for Open Graph / Twitter so shared links to a
  // back-version (e.g. /reference/api/v0.7.0) still render a card that
  // represents v0.7.0 specifically, not the latest.
  const selfUrl = buildCanonicalDocsUrl(params.slug);
  // SEO canonical. For archived pages in sections whose back-versions are
  // hidden from indexing (API summary), this points to the section's latest
  // (`/reference/api`) so search engines consolidate authority on the
  // canonical page. For every other page — including indexable archived
  // release-notes — this equals `selfUrl`.
  const linkCanonicalUrl = buildPageCanonicalUrl(params.slug);
  const ogImage = getPageImage(page);
  // Archived back-versions in `SECTIONS_HIDDEN_FROM_INDEXING` are hidden from
  // search engines and LLM training channels via per-page `noindex`. Combined
  // with `linkCanonicalUrl` pointing to the section's latest, this is the
  // textbook "this is a near-duplicate, prefer the canonical" signal. OG and
  // Twitter still carry the self-URL so social previews remain version-accurate.
  const isArchived = isArchivedVersionSlug(params.slug);

  return {
    title: isHomePage ? { absolute: title } : title,
    description,
    ...(isArchived && { robots: { index: false, follow: true } }),
    alternates: {
      canonical: linkCanonicalUrl,
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
  };
}

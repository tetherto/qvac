import { source } from '@/lib/source';
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
import { LLMCopyButton, ViewOptions } from '@/components/page-actions';

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

  // Filter ToC to include only H2 and H3 (depth 2 and 3)
  const filteredToc = page.data.toc?.filter(item => item.depth === 2 || item.depth === 3) || [];
  
  return (
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
        <LLMCopyButton markdownUrl={`/llms-full.txt`} />
        <ViewOptions
          markdownUrl={`/llms-full.txt`}
        />
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

  return {
    title: page.data.title,
    description: page.data.description,
  };
}

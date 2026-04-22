/**
 * JSON-LD (Schema.org) structured-data builders for documentation pages.
 *
 * Emits schema blocks consumed by search engines (Google rich results) and
 * AI crawlers for stronger semantic understanding of page content. Relies on
 * frontmatter `schemaType` for explicit typing; defaults to `TechArticle`.
 *
 * @see https://schema.org/
 * @see https://developers.google.com/search/docs/appearance/structured-data
 */

import {
  DOCS_SITE_ORIGIN,
  buildCanonicalDocsUrl,
  isArchivedVersionSlug,
} from './docs-open-graph';

export const SCHEMA_TYPES = [
  'APIReference',
  'TechArticle',
  'HowTo',
  'LearningResource',
  'WebSite',
] as const;

export type SchemaType = (typeof SCHEMA_TYPES)[number];

const PUBLISHER = {
  '@type': 'Organization',
  name: 'Tether',
  url: 'https://tether.io',
} as const;

/** Minimal structural shape of the Fumadocs page used by the builders below. */
type DocsPageLike = {
  data: {
    title?: string;
    description?: string;
    schemaType?: SchemaType;
    lastModified?: Date;
  };
};

type JsonLdBlock = Record<string, unknown>;

function getDocsSchemaType(page: DocsPageLike): SchemaType {
  return page.data.schemaType ?? 'TechArticle';
}

function getLastModifiedISO(page: DocsPageLike): string | undefined {
  const last = page.data.lastModified;
  if (!last) return undefined;
  const date = last instanceof Date ? last : new Date(last);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Build `BreadcrumbList` for non-home pages.
 *
 * Names come from raw slugs (no dictionary / Fumadocs lookup yet). Intermediate
 * items include an `item` URL; the final item (current page) omits it so search
 * engines treat the tail as the active page.
 */
function buildBreadcrumbList(slugs: string[]): JsonLdBlock {
  const items: JsonLdBlock[] = [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Docs',
      item: `${DOCS_SITE_ORIGIN}/`,
    },
  ];

  let accumulatedPath = '';
  for (let i = 0; i < slugs.length - 1; i++) {
    accumulatedPath += `/${encodeURIComponent(slugs[i])}`;
    items.push({
      '@type': 'ListItem',
      position: i + 2,
      name: slugs[i],
      item: `${DOCS_SITE_ORIGIN}${accumulatedPath}`,
    });
  }

  items.push({
    '@type': 'ListItem',
    position: slugs.length + 1,
    name: slugs[slugs.length - 1],
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items,
  };
}

/**
 * Home page emits two sibling blocks:
 * 1. `WebSite` — identifies the documentation site itself.
 * 2. `SoftwareApplication` — identifies QVAC as the documented product.
 *
 * No `SearchAction`: search is client-side (Fumadocs API), with no public
 * `/search?q=` URL to advertise.
 */
function buildHomeBlocks(): JsonLdBlock[] {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'QVAC Documentation',
      url: `${DOCS_SITE_ORIGIN}/`,
      publisher: PUBLISHER,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'QVAC',
      description:
        'Quantum Versatile AI Compute — local-first, peer-to-peer AI framework for developers.',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS, Windows, Android',
      publisher: PUBLISHER,
    },
  ];
}

function buildMainPageBlock(page: DocsPageLike, slugs: string[]): JsonLdBlock {
  const type = getDocsSchemaType(page);
  const url = buildCanonicalDocsUrl(slugs);
  const title = page.data.title ?? '';
  const description = page.data.description ?? '';
  const lastModifiedISO = getLastModifiedISO(page);

  // `TechArticle` uses `headline`; other Schema.org types here use `name`.
  const titleField: JsonLdBlock =
    type === 'TechArticle' ? { headline: title } : { name: title };

  const dateFields: JsonLdBlock = lastModifiedISO
    ? { dateModified: lastModifiedISO, datePublished: lastModifiedISO }
    : {};

  return {
    '@context': 'https://schema.org',
    '@type': type,
    ...titleField,
    description,
    url,
    publisher: PUBLISHER,
    ...dateFields,
  };
}

function buildPageBlocks(page: DocsPageLike, slugs: string[]): JsonLdBlock[] {
  return [buildMainPageBlock(page, slugs), buildBreadcrumbList(slugs)];
}

/**
 * Returns the JSON-LD blocks to render for `page`, or `null` when no
 * structured data should be emitted (archived version bundles).
 */
export function buildDocsJsonLd(
  page: DocsPageLike,
  slugs: string[],
  isHomePage: boolean,
): JsonLdBlock[] | null {
  if (isArchivedVersionSlug(slugs)) return null;
  return isHomePage ? buildHomeBlocks() : buildPageBlocks(page, slugs);
}

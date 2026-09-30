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

/**
 * Resolves a docs path (slug array) to the page that backs it, or `undefined`
 * when nothing is served there.
 *
 * Injected rather than imported so this module stays free of
 * `fumadocs-mdx:collections/server` — a virtual module resolved by the
 * Fumadocs bundler plugin, which the test runner does not load. Callers in
 * the app pass a `source.getPage`-backed lookup; tests pass a plain map.
 */
export type DocsPageLookup = (slugs: string[]) => DocsPageLike | undefined;

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
 * The trail is resolved against the page tree, not derived from the URL
 * structure: a path segment becomes a `ListItem` only when a real page backs
 * it. Content folders that ship no `index.mdx` (e.g. `ai-capabilities/`) are
 * therefore collapsed out of the trail entirely.
 *
 * Collapsing drops the whole `ListItem` rather than just its `item` URL,
 * because Google requires `item` on every entry except the last: "If the
 * breadcrumb is the last item in the breadcrumb trail, `item` is not
 * required." An interior entry without a URL is invalid, so there is no
 * "keep the level, omit the dead link" middle ground. Collapsing is also what
 * Google recommends outright — breadcrumbs "should represent a typical user
 * path to a page, instead of mirroring the URL structure" — and a `ListItem`
 * for the top-level path is explicitly not required.
 *
 * `position` is assigned from the emitted count, so it stays contiguous from
 * 1 after a level is collapsed. The list never falls below the two-item
 * minimum: the `Docs` root and the current page are always emitted.
 *
 * Names come from each resolved page's `title`, so the trail reads in the
 * same human wording as the sidebar ("AI Capabilities", not
 * `ai-capabilities`). The final item omits `item` so search engines treat the
 * tail as the active page.
 *
 * @see https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
 */
function buildBreadcrumbList(
  page: DocsPageLike,
  slugs: string[],
  lookupPage: DocsPageLookup,
): JsonLdBlock {
  const items: JsonLdBlock[] = [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Docs',
      item: `${DOCS_SITE_ORIGIN}/`,
    },
  ];

  for (let i = 0; i < slugs.length - 1; i++) {
    const trail = slugs.slice(0, i + 1);
    const ancestor = lookupPage(trail);
    // No page at this path — an index-less folder. Skip the level.
    if (!ancestor) continue;
    items.push({
      '@type': 'ListItem',
      position: items.length + 1,
      name: ancestor.data.title ?? slugs[i],
      item: buildCanonicalDocsUrl(trail),
    });
  }

  items.push({
    '@type': 'ListItem',
    position: items.length + 1,
    name: page.data.title ?? slugs[slugs.length - 1],
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

function buildPageBlocks(
  page: DocsPageLike,
  slugs: string[],
  lookupPage: DocsPageLookup,
): JsonLdBlock[] {
  return [
    buildMainPageBlock(page, slugs),
    buildBreadcrumbList(page, slugs, lookupPage),
  ];
}

/**
 * Returns the JSON-LD blocks to render for `page`, or `null` when no
 * structured data should be emitted (archived version bundles).
 *
 * `lookupPage` resolves breadcrumb ancestors against the page tree; see
 * `DocsPageLookup`. It is required so a missing lookup cannot silently
 * degrade every trail to a two-item stub.
 */
export function buildDocsJsonLd(
  page: DocsPageLike,
  slugs: string[],
  isHomePage: boolean,
  lookupPage: DocsPageLookup,
): JsonLdBlock[] | null {
  if (isArchivedVersionSlug(slugs)) return null;
  return isHomePage
    ? buildHomeBlocks()
    : buildPageBlocks(page, slugs, lookupPage);
}

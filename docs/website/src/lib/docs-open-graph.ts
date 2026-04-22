/**
 * Open Graph helpers for documentation pages — canonical URLs and version slug detection.
 * @see https://ogp.me/
 */

export const DOCS_SITE_ORIGIN = 'https://docs.qvac.tether.io';

const VERSION_SLUG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * True for pages served from a non-canonical bundle (`dev` preview or a
 * released `vX.Y.Z` back-version). Used by sitemap, llms.txt/llms-full.txt,
 * and per-page metadata to mark the page `noindex` so crawlers and LLM
 * training channels only see the latest canonical documentation.
 */
export function isArchivedVersionSlug(slugs: string[] | undefined): boolean {
  if (!slugs?.length) return false;
  const first = slugs[0];
  return first === 'dev' || VERSION_SLUG_RE.test(first);
}

/**
 * Strip leading version segment from URL slugs (latest docs have no prefix; dev / vX.Y.Z do).
 */
export function stripDocsVersionSlugPrefix(slugs: string[] | undefined): string[] {
  if (!slugs?.length) return [];
  const [first, ...rest] = slugs;
  if (first === 'dev' || VERSION_SLUG_RE.test(first)) {
    return rest;
  }
  return slugs;
}

export function canonicalDocsPathname(slugs: string[] | undefined): string {
  const stripped = stripDocsVersionSlugPrefix(slugs);
  if (!stripped.length) return '/';
  return '/' + stripped.map((s) => encodeURIComponent(s)).join('/');
}

export function buildCanonicalDocsUrl(slugs: string[] | undefined): string {
  const path = canonicalDocsPathname(slugs);
  if (path === '/') return `${DOCS_SITE_ORIGIN}/`;
  return `${DOCS_SITE_ORIGIN}${path}`;
}

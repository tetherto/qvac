/**
 * Open Graph helpers for documentation pages — canonical URLs and version slug detection.
 * @see https://ogp.me/
 */

export const DOCS_SITE_ORIGIN = 'https://docs.qvac.tether.io';

const VERSION_SLUG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * True for pages served from a released `vX.Y.Z` back-version bundle. Used by
 * sitemap, llms.txt/llms-full.txt, and per-page metadata to mark the page
 * `noindex` so crawlers and LLM training channels only see the latest
 * canonical documentation.
 */
export function isArchivedVersionSlug(slugs: string[] | undefined): boolean {
  if (!slugs?.length) return false;
  return VERSION_SLUG_RE.test(slugs[0]);
}

export function buildCanonicalDocsUrl(slugs: string[] | undefined): string {
  if (!slugs?.length) return `${DOCS_SITE_ORIGIN}/`;
  const path = slugs.map((s) => encodeURIComponent(s)).join('/');
  return `${DOCS_SITE_ORIGIN}/${path}`;
}

/**
 * Open Graph helpers for documentation pages — canonical URLs and the one
 * scope filter the aggregate corpora apply.
 * @see https://ogp.me/
 */

export const DOCS_SITE_ORIGIN = 'https://docs.qvac.tether.io';

/**
 * Minimal shape of a fumadocs page consumed here. Decoupled from
 * `InferPageType<typeof source>` so this module stays importable from tests,
 * Node scripts, and the fumadocs route handlers without dragging the full
 * source typing.
 */
export interface PageRef {
  url: string;
  slugs: string[];
}

/** The segments a line's release notes sit under, within the line. */
const RELEASE_NOTES_SEGMENTS = ['reference', 'release-notes'];

/**
 * True when the page belongs to the release-notes section of any line.
 *
 * Used exclusively by `llms-full.txt` to keep release notes out of the
 * full-documentation dump (QVAC-21379): each release note is a historical
 * changelog whose bulk text bloats the agent's token budget and dilutes its
 * reasoning without adding context it needs for day-to-day SDK usage. Release
 * notes stay indexed and discoverable everywhere else (sitemap, `llms.txt`,
 * per-page `.md`); an agent that specifically needs "what changed in vX.Y?"
 * can still fetch the individual page on demand.
 *
 * Matched on the segment pair wherever it occurs rather than on a fixed path,
 * so the section is recognized in whichever line publishes it — at
 * `/sdk/reference/release-notes` or at `/sdk/v0.16/reference/release-notes` —
 * along with anything below it.
 */
export function isReleaseNotesPage(page: PageRef): boolean {
  const segments = page.url.replace(/\/+$/, '').split('/');
  const [parent, section] = RELEASE_NOTES_SEGMENTS;
  return segments.some(
    (segment, i) => segment === section && segments[i - 1] === parent,
  );
}

/**
 * Self-URL of a docs page, which is also its canonical: a page is canonical
 * for its own line, so a page of the current line is canonical at its
 * version-less path and a page of any other line at its versioned path.
 *
 * Always returns URLs **with a trailing slash** to match the site's canonical
 * form (Next.js is configured with `trailingSlash: true`, and Sevalla's Pretty
 * URLs feature 301-redirects bare paths to the trailing-slash variant).
 * Keeping every emitted URL aligned with that form avoids contradictory
 * signals across `<link rel="canonical">`, `sitemap.xml`, and JSON-LD
 * breadcrumbs.
 */
export function buildCanonicalDocsUrl(slugs: string[] | undefined): string {
  if (!slugs?.length) return `${DOCS_SITE_ORIGIN}/`;
  const path = slugs.map((s) => encodeURIComponent(s)).join('/');
  return `${DOCS_SITE_ORIGIN}/${path}/`;
}

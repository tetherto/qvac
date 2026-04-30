/**
 * Open Graph helpers for documentation pages — canonical URLs and version slug detection.
 * @see https://ogp.me/
 */

export const DOCS_SITE_ORIGIN = 'https://docs.qvac.tether.io';

<<<<<<< HEAD
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

=======
>>>>>>> main
export function canonicalDocsPathname(slugs: string[] | undefined): string {
  if (!slugs?.length) return '/';
  return '/' + slugs.map((s) => encodeURIComponent(s)).join('/');
}

export function buildCanonicalDocsUrl(slugs: string[] | undefined): string {
  const path = canonicalDocsPathname(slugs);
  if (path === '/') return `${DOCS_SITE_ORIGIN}/`;
  return `${DOCS_SITE_ORIGIN}${path}`;
}
<<<<<<< HEAD
=======

export interface DiataxisOpenGraph {
  section: string;
  tags: string[];
}

function referenceTags(extra: string[]): string[] {
  return ['qvac', 'reference', ...extra];
}

/**
 * Map a Fumadocs virtual path (relative to `content/docs/`) to Diátaxis
 * quadrants for `article:section` and refinement tags.
 *
 * Versioned API summary and release-notes files (e.g. `sdk/api/v0.8.0.mdx`)
 * are still classified as `Reference` — the version segment lives in the
 * filename, not in a folder, so we match by directory only.
 */
export function inferDiataxisOpenGraph(virtualPath: string): DiataxisOpenGraph {
  const rel = virtualPath.toLowerCase();

  if (rel.startsWith('sdk/api/') || rel === 'sdk/api/index.mdx') {
    return {
      section: 'Reference',
      tags: referenceTags(['sdk', 'api']),
    };
  }

  if (rel.startsWith('sdk/release-notes/')) {
    return {
      section: 'Reference',
      tags: referenceTags(['sdk', 'release-notes']),
    };
  }

  if (rel.startsWith('tutorials/') || rel.startsWith('sdk/tutorials/')) {
    return {
      section: 'Tutorial',
      tags: ['qvac', 'sdk', 'tutorial'],
    };
  }

  if (rel.startsWith('sdk/getting-started/')) {
    return {
      section: 'getting-started',
      tags: ['qvac', 'sdk', 'getting-started'],
    };
  }

  if (rel.startsWith('sdk/examples/')) {
    return {
      section: 'Usage examples',
      tags: ['qvac', 'sdk', 'usage-examples', 'how-to'],
    };
  }

  if (rel.startsWith('addons/')) {
    return {
      section: 'Reference',
      tags: referenceTags(['addons']),
    };
  }

  if (rel.startsWith('about-qvac/')) {
    return {
      section: 'Explanation',
      tags: ['qvac', 'overview', 'explanation'],
    };
  }

  if (rel === 'cli.mdx' || rel === 'http-server.mdx') {
    return {
      section: 'Reference',
      tags: referenceTags(rel === 'cli.mdx' ? ['cli'] : ['http-server']),
    };
  }

  if (rel === 'index.mdx') {
    return {
      section: 'Explanation',
      tags: ['qvac', 'home', 'explanation'],
    };
  }

  return {
    section: 'Documentation',
    tags: ['qvac', 'documentation'],
  };
}
>>>>>>> main

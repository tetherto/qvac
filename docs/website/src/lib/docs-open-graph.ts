/**
 * Open Graph helpers for documentation pages — canonical URLs, Diátaxis-inspired sections.
 * @see https://ogp.me/
 * @see https://diataxis.fr/
 */

export const DOCS_SITE_ORIGIN = 'https://docs.qvac.tether.io';

export function canonicalDocsPathname(slugs: string[] | undefined): string {
  if (!slugs?.length) return '/';
  return '/' + slugs.map((s) => encodeURIComponent(s)).join('/');
}

export function buildCanonicalDocsUrl(slugs: string[] | undefined): string {
  const path = canonicalDocsPathname(slugs);
  if (path === '/') return `${DOCS_SITE_ORIGIN}/`;
  return `${DOCS_SITE_ORIGIN}${path}`;
}

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

/**
 * Open Graph helpers for documentation pages — canonical URLs, Diátaxis-inspired sections.
 * @see https://ogp.me/
 * @see https://diataxis.fr/
 */

export const DOCS_SITE_ORIGIN = 'https://docs.qvac.tether.io';

const VERSION_SLUG_RE = /^v\d+\.\d+\.\d+$/;

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

/**
 * Path relative to the bundled docs root (after `(latest)/`, `vX.Y.Z/`, or `dev/`).
 * Fumadocs virtual paths are relative to `content/docs`.
 */
export function pathRelativeToDocsBundle(virtualPath: string): string {
  return virtualPath
    .replace(/^\(latest\)\//, '')
    .replace(/^v\d+\.\d+\.\d+\//, '')
    .replace(/^dev\//, '');
}

export interface DiataxisOpenGraph {
  section: string;
  tags: string[];
}

function referenceTags(extra: string[]): string[] {
  return ['qvac', 'reference', ...extra];
}

/**
 * Map file layout to Diátaxis quadrants for `article:section` and refinement tags.
 */
export function inferDiataxisOpenGraph(virtualPath: string): DiataxisOpenGraph {
  const rel = pathRelativeToDocsBundle(virtualPath).toLowerCase();
  const isLatestBundle = virtualPath.startsWith('(latest)/');

  if (!isLatestBundle || rel.startsWith('sdk/api/')) {
    return {
      section: 'Reference',
      tags: referenceTags(rel.startsWith('sdk/api/') ? ['sdk', 'api'] : []),
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


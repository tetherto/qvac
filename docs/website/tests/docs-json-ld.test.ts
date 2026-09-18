import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocsJsonLd, type DocsPageLookup } from '@/lib/docs-json-ld';
import { DOCS_SITE_ORIGIN } from '@/lib/docs-open-graph';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_BASE = path.resolve(TESTS_DIR, '..', 'content', 'docs');

type Block = Record<string, unknown>;
type ListItem = { '@type': string; position: number; name: string; item?: string };

const page = (title: string, extra: Record<string, unknown> = {}) => ({
  data: { title, description: `${title} description`, ...extra },
});

/**
 * Page tree mirroring the real `content/docs/` layout: folders with an
 * `index.mdx` resolve to a page, index-less folders resolve to nothing.
 *
 * `ai-capabilities/` has no landing page; `cli/` and `cli/http-server/` do.
 */
const TREE: Record<string, ReturnType<typeof page>> = {
  'ai-capabilities/text-generation': page('Text Generation'),
  cli: page('CLI'),
  'cli/http-server': page('HTTP Server'),
  'cli/http-server/connection': page('Connection'),
  configuration: page('Configuration'),
  'configuration/plugins': page('Plugins'),
  introduction: page('Introduction'),
  'reference/release-notes': page('Release Notes'),
  'reference/release-notes/v0.8.x': page('v0.8.x Release Notes'),
};

const lookup: DocsPageLookup = (slugs) => TREE[slugs.join('/')];

/** The `BreadcrumbList` block, which `buildPageBlocks` emits second. */
function breadcrumbs(slugs: string[], isHomePage = false): ListItem[] {
  const blocks = buildDocsJsonLd(
    TREE[slugs.join('/')] ?? page('Untitled'),
    slugs,
    isHomePage,
    lookup,
  );
  const list = blocks?.find((b) => b['@type'] === 'BreadcrumbList') as
    | Block
    | undefined;
  return (list?.itemListElement ?? []) as ListItem[];
}

describe('buildDocsJsonLd — archived version slugs', () => {
  it('emits nothing for an archived API version (hidden from indexing)', () => {
    const slugs = ['reference', 'api', 'v0.8.x'];
    expect(buildDocsJsonLd(page('v0.8.x'), slugs, false, lookup)).toBeNull();
  });
});

describe('buildDocsJsonLd — home page', () => {
  it('emits WebSite and SoftwareApplication, and no BreadcrumbList', () => {
    const blocks = buildDocsJsonLd(page('QVAC'), [], true, lookup);
    expect(blocks?.map((b) => b['@type'])).toEqual([
      'WebSite',
      'SoftwareApplication',
    ]);
  });
});

describe('buildBreadcrumbList — index-less folders are collapsed', () => {
  it('omits the level for a folder with no index.mdx', () => {
    // `/ai-capabilities/` returns 404, so it must not appear at all —
    // Google requires `item` on every non-final entry, leaving no way to
    // keep the level without a URL.
    const items = breadcrumbs(['ai-capabilities', 'text-generation']);

    expect(items).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Docs', item: `${DOCS_SITE_ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Text Generation' },
    ]);
  });

  it('never emits a URL for an index-less folder', () => {
    const urls = breadcrumbs(['ai-capabilities', 'text-generation'])
      .map((i) => i.item)
      .filter(Boolean);

    expect(urls).not.toContain(`${DOCS_SITE_ORIGIN}/ai-capabilities/`);
  });

  it('keeps the two-item minimum when the whole trail collapses', () => {
    // Google: a BreadcrumbList must contain at least two ListItems.
    expect(breadcrumbs(['ai-capabilities', 'text-generation'])).toHaveLength(2);
  });
});

describe('buildBreadcrumbList — folders that have an index.mdx', () => {
  it('emits the level with a trailing-slash URL', () => {
    const items = breadcrumbs(['configuration', 'plugins']);

    expect(items).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Docs', item: `${DOCS_SITE_ORIGIN}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Configuration',
        item: `${DOCS_SITE_ORIGIN}/configuration/`,
      },
      { '@type': 'ListItem', position: 3, name: 'Plugins' },
    ]);
  });

  it('emits every level of a 3-level path when all are backed by pages', () => {
    const items = breadcrumbs(['cli', 'http-server', 'connection']);

    expect(items).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Docs', item: `${DOCS_SITE_ORIGIN}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'CLI',
        item: `${DOCS_SITE_ORIGIN}/cli/`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'HTTP Server',
        item: `${DOCS_SITE_ORIGIN}/cli/http-server/`,
      },
      { '@type': 'ListItem', position: 4, name: 'Connection' },
    ]);
  });

  it('collapses only the index-less level of a mixed 3-level path', () => {
    // `reference/` has no index.mdx but `reference/release-notes/` does.
    // Archived release notes stay indexable, so they still emit JSON-LD.
    const items = breadcrumbs(['reference', 'release-notes', 'v0.8.x']);

    expect(items).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Docs', item: `${DOCS_SITE_ORIGIN}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Release Notes',
        item: `${DOCS_SITE_ORIGIN}/reference/release-notes/`,
      },
      { '@type': 'ListItem', position: 3, name: 'v0.8.x Release Notes' },
    ]);
  });
});

describe('buildBreadcrumbList — Google spec invariants', () => {
  const paths = [
    ['introduction'],
    ['ai-capabilities', 'text-generation'],
    ['configuration', 'plugins'],
    ['cli', 'http-server', 'connection'],
    ['reference', 'release-notes', 'v0.8.x'],
  ];

  it('assigns contiguous positions starting at 1', () => {
    for (const slugs of paths) {
      const positions = breadcrumbs(slugs).map((i) => i.position);
      expect(positions).toEqual(positions.map((_, i) => i + 1));
    }
  });

  it('gives every item except the last an `item` URL', () => {
    for (const slugs of paths) {
      const items = breadcrumbs(slugs);
      const interior = items.slice(0, -1);
      expect(interior.every((i) => typeof i.item === 'string')).toBe(true);
      expect(items[items.length - 1].item).toBeUndefined();
    }
  });

  it('gives every item a name', () => {
    for (const slugs of paths) {
      expect(breadcrumbs(slugs).every((i) => Boolean(i.name))).toBe(true);
    }
  });

  it('never emits a raw slug as a name when a page title exists', () => {
    const names = breadcrumbs(['ai-capabilities', 'text-generation']).map(
      (i) => i.name,
    );
    expect(names).not.toContain('ai-capabilities');
    expect(names).not.toContain('text-generation');
  });
});

describe('buildBreadcrumbList — top-level pages', () => {
  it('emits Docs plus the page itself', () => {
    expect(breadcrumbs(['introduction'])).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Docs', item: `${DOCS_SITE_ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Introduction' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration test: every breadcrumb URL the real content tree produces must
// resolve to a real page.
//
// This is the CI regression guard for QVAC-25261. It lives here rather than in
// `link-integrity.test.ts` because that suite validates links written inside
// MDX bodies, while this one validates URLs synthesized by a TypeScript
// builder — different input, different failure mode, same guarantee.
//
// The lookup is built from the filesystem instead of the Fumadocs `source`,
// which imports the virtual `fumadocs-mdx:collections/server` module that the
// test runner cannot resolve. Fumadocs derives its routes from exactly these
// files, so the two agree on which paths are served.
// ---------------------------------------------------------------------------

/** Slug array served by a content file, or `null` for the home page. */
function slugsForFile(relPath: string): string[] | null {
  const withoutExt = relPath.replace(/\.mdx?$/, '');
  const trimmed = withoutExt.replace(/(^|\/)index$/, '');
  if (trimmed === '') return null;
  return trimmed.replace(/^\//, '').split('/');
}

async function buildRealPageSet(): Promise<Set<string>> {
  const entries = await fs.readdir(DOCS_BASE, { recursive: true });
  const pages = new Set<string>();
  for (const entry of entries) {
    const rel = entry.replace(/\\/g, '/');
    if (!/\.mdx?$/.test(rel)) continue;
    const slugs = slugsForFile(rel);
    if (slugs) pages.add(slugs.join('/'));
  }
  return pages;
}

describe('docs breadcrumb URL integrity', () => {
  it('emits no breadcrumb URL that lacks a backing page', async () => {
    const pageSet = await buildRealPageSet();
    const realLookup: DocsPageLookup = (slugs) =>
      pageSet.has(slugs.join('/')) ? page(slugs[slugs.length - 1]) : undefined;

    const dead: string[] = [];

    for (const key of pageSet) {
      const slugs = key.split('/');
      const blocks = buildDocsJsonLd(page(slugs[slugs.length - 1]), slugs, false, realLookup);
      // `null` = archived version bundle, which emits no structured data.
      if (!blocks) continue;

      const list = blocks.find((b) => b['@type'] === 'BreadcrumbList') as
        | Block
        | undefined;

      for (const item of (list?.itemListElement ?? []) as ListItem[]) {
        if (!item.item) continue;
        const urlPath = item.item.slice(DOCS_SITE_ORIGIN.length).replace(/^\/|\/$/g, '');
        // The site root is served by `content/docs/index.mdx`, which maps to
        // the empty slug array and so is absent from `pageSet`.
        if (urlPath === '') continue;
        if (!pageSet.has(urlPath)) dead.push(`/${key} → ${item.item}`);
      }
    }

    if (dead.length > 0) {
      expect.fail(
        `Found ${dead.length} breadcrumb URL(s) with no backing page:\n` +
          dead.map((d) => `  ${d}`).join('\n'),
      );
    }
  });

  it('covers the index-less folders that motivated the fix', async () => {
    // Guards the test above against silently passing on an empty tree, and
    // pins the premise: these folders ship no landing page.
    const pageSet = await buildRealPageSet();
    expect(pageSet.size).toBeGreaterThan(50);
    for (const folder of [
      'about',
      'ai-capabilities',
      'models',
      'p2p-capabilities',
      'reference',
      'runtime',
      'tutorials',
    ]) {
      expect(pageSet.has(folder), `${folder} unexpectedly has a landing page`).toBe(false);
    }
  });
});

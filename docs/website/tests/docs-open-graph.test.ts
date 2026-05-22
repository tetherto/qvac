import { describe, it, expect } from 'vitest';
import {
  isArchivedPage,
  isArchivedVersionSlug,
  buildCanonicalDocsUrl,
  buildPageCanonicalUrl,
  DOCS_SITE_ORIGIN,
} from '@/lib/docs-open-graph';

const page = (url: string, slugs?: string[]) => ({
  url,
  slugs: slugs ?? (url === '/' ? [] : url.replace(/^\/+/, '').split('/')),
});

describe('isArchivedPage', () => {
  it('returns false for the home page', () => {
    expect(isArchivedPage(page('/'))).toBe(false);
  });

  it('returns false for a regular non-versioned page', () => {
    expect(isArchivedPage(page('/quickstart'))).toBe(false);
  });

  it('returns false for the latest API page (served at the bare basePath)', () => {
    expect(isArchivedPage(page('/reference/api'))).toBe(false);
  });

  it('returns false for the latest release-notes page', () => {
    expect(isArchivedPage(page('/reference/release-notes'))).toBe(false);
  });

  it('returns true for archived per-section API versions', () => {
    // API summary archives are hidden from indexing: near-duplicate content
    // (~80% overlap across versions) causes duplicate-content SEO problems
    // and cross-version hallucination in LLMs.
    expect(isArchivedPage(page('/reference/api/v0.7.0'))).toBe(true);
    expect(isArchivedPage(page('/reference/api/v0.8.0'))).toBe(true);
    expect(isArchivedPage(page('/reference/api/v0.9.1'))).toBe(true);
  });

  it('returns false for archived release-notes versions (kept indexable)', () => {
    // Each archived release-note is a unique historical document describing
    // what changed in a specific release — no duplicate-content problem, and
    // excluding them would make "what changed in v0.8.0?" undiscoverable.
    // Kept in sitemap.xml, llms.txt, llms-full.txt, and per-page `.md`.
    expect(isArchivedPage(page('/reference/release-notes/v0.7.0'))).toBe(false);
    expect(isArchivedPage(page('/reference/release-notes/v0.8.0'))).toBe(false);
    expect(isArchivedPage(page('/reference/release-notes/v0.9.1'))).toBe(false);
  });

  it('returns true for legacy bundle-style URLs (defensive fallback)', () => {
    expect(isArchivedPage(page('/v0.7.0/foo', ['v0.7.0', 'foo']))).toBe(true);
    expect(isArchivedPage(page('/v0.7.0', ['v0.7.0']))).toBe(true);
  });

  it('does not treat a version-shaped second segment as archived', () => {
    expect(isArchivedPage(page('/guides/v1.0.0/example'))).toBe(false);
  });
});

describe('isArchivedVersionSlug', () => {
  it('returns false for empty / missing slugs', () => {
    expect(isArchivedVersionSlug(undefined)).toBe(false);
    expect(isArchivedVersionSlug([])).toBe(false);
  });

  it('returns false for non-versioned pages', () => {
    expect(isArchivedVersionSlug(['quickstart'])).toBe(false);
    expect(isArchivedVersionSlug(['reference', 'api'])).toBe(false);
  });

  it('returns true for archived API summary versions', () => {
    expect(isArchivedVersionSlug(['reference', 'api', 'v0.7.0'])).toBe(true);
    expect(isArchivedVersionSlug(['reference', 'api', 'v0.9.1'])).toBe(true);
  });

  it('returns false for archived release-notes versions (kept indexable)', () => {
    expect(
      isArchivedVersionSlug(['reference', 'release-notes', 'v0.7.0']),
    ).toBe(false);
    expect(
      isArchivedVersionSlug(['reference', 'release-notes', 'v0.9.1']),
    ).toBe(false);
  });

  it('returns true for legacy bundle slugs', () => {
    expect(isArchivedVersionSlug(['v0.7.0'])).toBe(true);
    expect(isArchivedVersionSlug(['v0.7.0', 'anything'])).toBe(true);
  });
});

describe('buildCanonicalDocsUrl', () => {
  it('returns the site root for empty / undefined slugs', () => {
    expect(buildCanonicalDocsUrl(undefined)).toBe(`${DOCS_SITE_ORIGIN}/`);
    expect(buildCanonicalDocsUrl([])).toBe(`${DOCS_SITE_ORIGIN}/`);
  });

  it('joins slugs with `/`', () => {
    expect(buildCanonicalDocsUrl(['reference', 'api'])).toBe(
      `${DOCS_SITE_ORIGIN}/reference/api`,
    );
  });

  it('encodes path components', () => {
    expect(buildCanonicalDocsUrl(['foo bar'])).toBe(
      `${DOCS_SITE_ORIGIN}/foo%20bar`,
    );
  });

  it('returns the self-URL even for archived API pages (used by OG, not <link rel=canonical>)', () => {
    expect(buildCanonicalDocsUrl(['reference', 'api', 'v0.7.0'])).toBe(
      `${DOCS_SITE_ORIGIN}/reference/api/v0.7.0`,
    );
  });
});

describe('buildPageCanonicalUrl', () => {
  it('returns the site root for the home page', () => {
    expect(buildPageCanonicalUrl(undefined)).toBe(`${DOCS_SITE_ORIGIN}/`);
    expect(buildPageCanonicalUrl([])).toBe(`${DOCS_SITE_ORIGIN}/`);
  });

  it('returns the self-URL for non-versioned pages', () => {
    expect(buildPageCanonicalUrl(['quickstart'])).toBe(
      `${DOCS_SITE_ORIGIN}/quickstart`,
    );
    expect(buildPageCanonicalUrl(['reference', 'api'])).toBe(
      `${DOCS_SITE_ORIGIN}/reference/api`,
    );
  });

  it('redirects archived API pages to /reference/api (the section latest)', () => {
    expect(buildPageCanonicalUrl(['reference', 'api', 'v0.7.0'])).toBe(
      `${DOCS_SITE_ORIGIN}/reference/api`,
    );
    expect(buildPageCanonicalUrl(['reference', 'api', 'v0.8.0'])).toBe(
      `${DOCS_SITE_ORIGIN}/reference/api`,
    );
    expect(buildPageCanonicalUrl(['reference', 'api', 'v0.9.1'])).toBe(
      `${DOCS_SITE_ORIGIN}/reference/api`,
    );
  });

  it('keeps archived release-notes pages as their own canonical', () => {
    expect(
      buildPageCanonicalUrl(['reference', 'release-notes', 'v0.7.0']),
    ).toBe(`${DOCS_SITE_ORIGIN}/reference/release-notes/v0.7.0`);
    expect(
      buildPageCanonicalUrl(['reference', 'release-notes', 'v0.9.1']),
    ).toBe(`${DOCS_SITE_ORIGIN}/reference/release-notes/v0.9.1`);
  });
});

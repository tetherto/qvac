import { describe, it, expect } from 'vitest';
import {
  isReleaseNotesPage,
  buildCanonicalDocsUrl,
  DOCS_SITE_ORIGIN,
} from '@/lib/docs-open-graph';

const page = (url: string, slugs?: string[]) => ({
  url,
  slugs: slugs ?? (url === '/' ? [] : url.replace(/^\/+/, '').split('/')),
});

describe('isReleaseNotesPage', () => {
  it('returns true for the current line release notes', () => {
    expect(isReleaseNotesPage(page('/sdk/reference/release-notes'))).toBe(true);
  });

  it('returns true for another line release notes', () => {
    // Excluded from the llms-full.txt bulk dump to reduce token consumption
    // (QVAC-21379), while staying indexed everywhere else — in every line.
    expect(isReleaseNotesPage(page('/sdk/v0.16/reference/release-notes'))).toBe(
      true,
    );
  });

  it('returns true for a page below the section', () => {
    expect(
      isReleaseNotesPage(page('/sdk/v0.16/reference/release-notes/v0.16.2')),
    ).toBe(true);
  });

  it('returns false for non-release-notes pages', () => {
    expect(isReleaseNotesPage(page('/'))).toBe(false);
    expect(isReleaseNotesPage(page('/quickstart'))).toBe(false);
    expect(isReleaseNotesPage(page('/sdk/reference/api'))).toBe(false);
    expect(isReleaseNotesPage(page('/sdk/v0.16/reference/api'))).toBe(false);
  });

  it('does not match a look-alike sibling path (prefix guard)', () => {
    expect(isReleaseNotesPage(page('/sdk/reference/release-notes-guide'))).toBe(
      false,
    );
  });

  it('does not match the segment outside its section', () => {
    expect(isReleaseNotesPage(page('/ecosystem/release-notes'))).toBe(false);
  });
});

describe('buildCanonicalDocsUrl', () => {
  it('returns the site root for empty / undefined slugs', () => {
    expect(buildCanonicalDocsUrl(undefined)).toBe(`${DOCS_SITE_ORIGIN}/`);
    expect(buildCanonicalDocsUrl([])).toBe(`${DOCS_SITE_ORIGIN}/`);
  });

  it('joins slugs with `/` and appends a trailing slash', () => {
    expect(buildCanonicalDocsUrl(['sdk', 'reference', 'api'])).toBe(
      `${DOCS_SITE_ORIGIN}/sdk/reference/api/`,
    );
  });

  it('encodes path components', () => {
    expect(buildCanonicalDocsUrl(['foo bar'])).toBe(
      `${DOCS_SITE_ORIGIN}/foo%20bar/`,
    );
  });

  it('leaves a page of another line canonical for itself', () => {
    expect(buildCanonicalDocsUrl(['sdk', 'v0.16', 'reference', 'api'])).toBe(
      `${DOCS_SITE_ORIGIN}/sdk/v0.16/reference/api/`,
    );
  });
});

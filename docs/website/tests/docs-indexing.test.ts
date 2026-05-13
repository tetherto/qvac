import { describe, it, expect, afterEach, vi } from 'vitest';
import { allowDocsIndexingAtBuildTime, docsRootMetadataRobots } from '@/lib/docs-indexing';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('allowDocsIndexingAtBuildTime', () => {
  it('is false when no relevant env is set', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', '');
    expect(allowDocsIndexingAtBuildTime()).toBe(false);
  });

  it('is true when DOCS_ALLOW_INDEXING=true', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');
    expect(allowDocsIndexingAtBuildTime()).toBe(true);
  });

  it('is true when DOCS_ALLOW_INDEXING=TRUE (case-insensitive)', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', 'TRUE');
    expect(allowDocsIndexingAtBuildTime()).toBe(true);
  });

  it('is true when DOCS_ALLOW_INDEXING=True (case-insensitive)', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', 'True');
    expect(allowDocsIndexingAtBuildTime()).toBe(true);
  });

  it('is false when DOCS_ALLOW_INDEXING=1 (rejects non-true values)', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', '1');
    expect(allowDocsIndexingAtBuildTime()).toBe(false);
  });

  it('is false when DOCS_ALLOW_INDEXING=yes (rejects non-true values)', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', 'yes');
    expect(allowDocsIndexingAtBuildTime()).toBe(false);
  });

  it('is false when DOCS_ALLOW_INDEXING=false', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', 'false');
    expect(allowDocsIndexingAtBuildTime()).toBe(false);
  });
});

describe('docsRootMetadataRobots', () => {
  it('matches allow flag', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', 'true');
    expect(docsRootMetadataRobots()).toEqual({ index: true, follow: true });
  });

  it('emits noindex when not allowed', () => {
    vi.stubEnv('DOCS_ALLOW_INDEXING', '');
    expect(docsRootMetadataRobots()).toEqual({ index: false, follow: false });
  });
});

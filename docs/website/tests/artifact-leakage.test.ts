import { describe, expect, it } from 'vitest';
import {
  classifyUrl,
  collectionsFromManifest,
  extractUrls,
  leakReason,
  SITE_ORIGIN,
  type Collection,
} from '../scripts/lib/artifact-leakage';

/**
 * What the build gate decides about a URL an artifact names. The cases the
 * built site cannot currently produce — a page of one line naming another,
 * an older line of a second collection — are the ones worth pinning, since
 * they are what the gate exists to catch and what nothing else would.
 */

const COLLECTIONS: Collection[] = [
  {
    path: '/sdk',
    package: '@qvac/sdk',
    lines: [
      { version: 'v0.17', current: true },
      { version: 'v0.16', current: false },
    ],
  },
  {
    path: '/cli',
    package: '@qvac/cli',
    lines: [
      { version: 'v0.9', current: true },
      { version: 'v0.8', current: false },
    ],
  },
];

const V016 = { collection: '/sdk', version: 'v0.16' };
const V017 = { collection: '/sdk', version: 'v0.17' };

const PREFIXES = ['/sdk', '/cli', '/ecosystem', '/resources', '/llms.txt'];

describe('classifyUrl', () => {
  it('reads a version segment as the line it names', () => {
    expect(classifyUrl('/sdk/v0.16/quickstart', COLLECTIONS)).toEqual({
      kind: 'line',
      collection: '/sdk',
      version: 'v0.16',
    });
  });

  it('reads a version-less path as the current line', () => {
    expect(classifyUrl('/sdk/quickstart/', COLLECTIONS)).toEqual({
      kind: 'line',
      collection: '/sdk',
      version: 'v0.17',
    });
  });

  it('leaves a collection that publishes no lines unversioned', () => {
    expect(classifyUrl('/ecosystem/addons', COLLECTIONS)).toEqual({
      kind: 'unversioned',
    });
  });

  it('treats a collection resolver as belonging to no line', () => {
    expect(classifyUrl('/sdk/llms.txt', COLLECTIONS)).toEqual({
      kind: 'unversioned',
    });
    expect(classifyUrl('/sdk/versions.json', COLLECTIONS)).toEqual({
      kind: 'unversioned',
    });
  });

  it('keeps a line corpus inside its line', () => {
    expect(classifyUrl('/sdk/v0.16/llms-full.txt', COLLECTIONS)).toEqual({
      kind: 'line',
      collection: '/sdk',
      version: 'v0.16',
    });
  });
});

describe('leakReason', () => {
  it('rejects another line of the same collection', () => {
    expect(leakReason('/sdk/quickstart', V016, COLLECTIONS)).toContain('v0.17');
    expect(leakReason('/sdk/v0.16/quickstart', V017, COLLECTIONS)).toContain(
      'v0.16',
    );
  });

  it('accepts the line it is scoped to', () => {
    expect(leakReason('/sdk/v0.16/quickstart/', V016, COLLECTIONS)).toBeNull();
    expect(leakReason('/sdk/quickstart', V017, COLLECTIONS)).toBeNull();
  });

  it('accepts an unversioned page from any line', () => {
    expect(leakReason('/ecosystem/addons', V016, COLLECTIONS)).toBeNull();
    expect(leakReason('/resources/docs-for-ai-agents', V016, COLLECTIONS)).toBeNull();
  });

  it('accepts another versioned collection at its current line', () => {
    expect(leakReason('/cli/http-server', V016, COLLECTIONS)).toBeNull();
  });

  it('rejects another versioned collection at an older line', () => {
    expect(leakReason('/cli/v0.8/http-server', V016, COLLECTIONS)).toContain(
      'not that collection',
    );
  });

  it('lets an artifact above the lines name every line', () => {
    expect(leakReason('/sdk/v0.16/llms-full.txt', null, COLLECTIONS)).toBeNull();
    expect(leakReason('/cli/v0.8/', null, COLLECTIONS)).toBeNull();
  });
});

describe('extractUrls', () => {
  it('takes a Markdown link and a bare path', () => {
    const text = 'See [quickstart](/sdk/quickstart) or /ecosystem/addons for more.';
    expect(extractUrls(text, PREFIXES).sort()).toEqual([
      '/ecosystem/addons',
      '/sdk/quickstart',
    ]);
  });

  it('ignores a path that only ends up looking like one', () => {
    const text = "import x from '@qvac/sdk/client/index.js' // packages/sdk/dist";
    expect(extractUrls(text, PREFIXES)).toEqual([]);
  });

  it('ignores a root path the site does not publish', () => {
    expect(extractUrls('run /usr/local/bin/qvac', PREFIXES)).toEqual([]);
  });

  it('reads an absolute URL of this site as the path it is', () => {
    expect(extractUrls(`${SITE_ORIGIN}/sdk/v0.16/quickstart/`, PREFIXES)).toEqual([
      '/sdk/v0.16/quickstart/',
    ]);
  });

  it('drops the punctuation a sentence ends on, but not an extension', () => {
    const text = 'Fetch /sdk/llms.txt, then /sdk/quickstart.';
    expect(extractUrls(text, PREFIXES).sort()).toEqual([
      '/sdk/llms.txt',
      '/sdk/quickstart',
    ]);
  });
});

describe('the manifest the gate reads', () => {
  it('describes the collections published as lines', () => {
    const collections = collectionsFromManifest();
    expect(collections.map((collection) => collection.path)).toEqual([
      '/sdk',
      '/cli',
    ]);
    for (const collection of collections) {
      expect(collection.lines.filter((line) => line.current)).toHaveLength(1);
    }
  });
});

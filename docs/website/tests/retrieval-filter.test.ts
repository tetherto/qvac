import { describe, expect, it } from 'vitest';
import {
  allowedLines,
  lineLabelOf,
  retrievalFilter,
} from '../src/lib/retrieval-filter';
import { inkeepMetaTags, pageAttributes } from '../src/lib/page-attributes';
import {
  documentedSoftwareOfKind,
  getCurrentLine,
  versionOfFolder,
} from '../src/lib/versions';

/**
 * What a query issued from a given page is allowed to reach. Retrieval
 * happens at Inkeep, so what can be tested here is the contract the site
 * sends: the attributes each page publishes, and the filter each page
 * produces. The leakage measured is therefore structural — for every page of
 * every line, no other line of that page's own collection is reachable.
 */

const SDK = documentedSoftwareOfKind('collection').find(
  (software) => software.path === '/sdk',
)!;
const CLI = documentedSoftwareOfKind('collection').find(
  (software) => software.path === '/cli',
)!;

const SDK_CURRENT = versionOfFolder(getCurrentLine(SDK)!.folder);
const SDK_OLDER = SDK.versions.find(
  (version) => version.version !== SDK_CURRENT,
)!.version;
const CLI_CURRENT = versionOfFolder(getCurrentLine(CLI)!.folder);

describe('pageAttributes', () => {
  it('states the line of a page that carries no version in its URL', () => {
    expect(pageAttributes('/sdk/quickstart')).toEqual({
      collection: 'SDK',
      package: '@qvac/sdk',
      line: SDK_CURRENT,
      currentLine: true,
    });
  });

  it('states the line of a page that carries one', () => {
    expect(pageAttributes(`/sdk/${SDK_OLDER}/quickstart`)).toEqual({
      collection: 'SDK',
      package: '@qvac/sdk',
      line: SDK_OLDER,
      currentLine: false,
    });
  });

  it('gives an unversioned page a collection and no line', () => {
    expect(pageAttributes('/ecosystem/addons')).toEqual({
      collection: 'Ecosystem',
    });
  });

  it('publishes them as the meta tags the crawler reads', () => {
    expect(inkeepMetaTags(`/sdk/${SDK_OLDER}/quickstart`)).toEqual({
      'inkeep:collection': 'SDK',
      'inkeep:package': '@qvac/sdk',
      'inkeep:line': SDK_OLDER,
      'inkeep:current_line': 'false',
    });
    expect(inkeepMetaTags('/resources')).toEqual({
      'inkeep:collection': 'Resources',
    });
  });
});

describe('allowedLines', () => {
  it('takes the reader’s own line where the reader is', () => {
    const allowed = allowedLines(`/sdk/${SDK_OLDER}/quickstart`);
    expect(allowed).toContainEqual({ collection: 'SDK', line: SDK_OLDER });
  });

  it('takes the current line of every other versioned collection', () => {
    const allowed = allowedLines(`/sdk/${SDK_OLDER}/quickstart`);
    expect(allowed).toContainEqual({
      collection: 'CLI',
      line: CLI_CURRENT,
    });
  });

  it('takes every current line when the reader is outside them all', () => {
    expect(allowedLines('/ecosystem/addons')).toEqual([
      { collection: 'SDK', line: SDK_CURRENT },
      { collection: 'CLI', line: CLI_CURRENT },
    ]);
  });

  it('allows exactly one line per collection, wherever the reader is', () => {
    for (const pathname of [
      '/',
      '/sdk',
      `/sdk/${SDK_OLDER}`,
      `/sdk/${SDK_OLDER}/reference/api`,
      '/cli/http-server',
      '/resources/corpus-protocol',
    ]) {
      const collections = allowedLines(pathname).map((entry) => entry.collection);
      expect(new Set(collections).size).toBe(collections.length);
    }
  });
});

describe('retrievalFilter', () => {
  it('never admits another line of the reader’s own collection', () => {
    const filter = retrievalFilter(`/sdk/${SDK_OLDER}/quickstart`);
    const clauses = JSON.stringify(filter);
    expect(clauses).toContain(SDK_OLDER);
    expect(clauses).not.toContain(SDK_CURRENT);
  });

  it('admits the collections that publish no lines', () => {
    const filter = retrievalFilter(`/sdk/${SDK_OLDER}/quickstart`);
    expect(filter.attributes.$or).toContainEqual({
      collection: { $in: ['Ecosystem', 'Resources'] },
    });
  });

  it('pairs a collection with a line, so a version alone matches nothing', () => {
    const filter = retrievalFilter('/sdk/quickstart');
    for (const clause of filter.attributes.$or) {
      if (!('$and' in clause)) continue;
      expect(clause.$and).toHaveLength(2);
      expect(Object.keys(clause.$and[0])).toEqual(['collection']);
      expect(Object.keys(clause.$and[1])).toEqual(['line']);
    }
  });

  it('falls back to the current lines outside any line', () => {
    expect(retrievalFilter('/ecosystem')).toEqual(retrievalFilter('/'));
  });
});

describe('lineLabelOf', () => {
  it('labels a result from a line that is not the current one', () => {
    expect(lineLabelOf(`https://docs.qvac.tether.io/sdk/${SDK_OLDER}/quickstart/`)).toBe(
      SDK_OLDER,
    );
  });

  it('leaves the current line and unversioned pages unlabelled', () => {
    expect(lineLabelOf('https://docs.qvac.tether.io/sdk/quickstart/')).toBeNull();
    expect(lineLabelOf('/ecosystem/addons')).toBeNull();
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  cutLine,
  cutManifest,
  cutRedirects,
  relabelTitle,
} from '../scripts/cut-line';
import { DOCUMENTED_SOFTWARE } from '../src/lib/versions';

/**
 * The cut, exercised against a copy of the tree.
 *
 * `cut-line.ts` is a convenience: a cut made by hand is the same cut, and the
 * build is what accepts either. What is tested here is that the command
 * produces the edit the hand procedure in `README.md` describes, and that it
 * refuses everything it cannot make reviewable.
 */

const WEBSITE = path.resolve(__dirname, '..');
const sdk = DOCUMENTED_SOFTWARE.find(
  (software) => software.path === '/sdk' && software.kind === 'collection',
)!;
const CURRENT = sdk.versions.find((entry) => entry.folder.startsWith('('))!.version;
/** The line a cut would open next, derived so a real cut never dates this. */
const NEXT = (() => {
  const [major, minor] = CURRENT.replace(/^v/, '').split('.');
  return `v${major}.${Number(minor) + 1}`;
})();

describe('the manifest edit', () => {
  const manifest = [
    'export const DOCUMENTED_SOFTWARE = [',
    '  {',
    "    package: '@qvac/sdk',",
    "    kind: 'collection',",
    "    path: '/sdk',",
    '    versions: [',
    "      { version: 'v0.20', folder: '(v0.20)' },",
    "      { version: 'v0.19', folder: 'v0.19' },",
    '    ],',
    '  },',
    '] as const;',
    '',
  ].join('\n');

  it('unwraps the preserved line and inserts the opened one above it', () => {
    expect(cutManifest(manifest, '/sdk', 'v0.20', 'v0.21')).toContain(
      [
        '    versions: [',
        "      { version: 'v0.21', folder: '(v0.21)' },",
        "      { version: 'v0.20', folder: 'v0.20' },",
        "      { version: 'v0.19', folder: 'v0.19' },",
        '    ],',
      ].join('\n'),
    );
  });

  it('leaves the entries below it alone', () => {
    expect(cutManifest(manifest, '/sdk', 'v0.20', 'v0.21')).toContain(
      "{ version: 'v0.19', folder: 'v0.19' }",
    );
  });

  it('refuses a collection the manifest does not carry', () => {
    expect(() => cutManifest(manifest, '/rag', 'v0.20', 'v0.21')).toThrow(
      /no entry at/,
    );
  });

  it('refuses when the named line is not the current one', () => {
    expect(() => cutManifest(manifest, '/sdk', 'v0.19', 'v0.21')).toThrow(
      /does not declare v0\.19 as its current line/,
    );
  });
});

describe('the redirect pair', () => {
  const redirects = [
    '# a comment',
    '/sdk/v0.19/        /sdk/v0.19/index.html        200',
    '/sdk/v0.19         /sdk/v0.19/                  301',
    '/cli/v0.13/        /cli/v0.13/index.html        200',
    '/cli/v0.13         /cli/v0.13/                  301',
    '',
  ].join('\n');

  it('goes at the head of its own collection, in the block format', () => {
    expect(cutRedirects(redirects, 'sdk', 'v0.20')).toContain(
      [
        '/sdk/v0.20/        /sdk/v0.20/index.html        200',
        '/sdk/v0.20         /sdk/v0.20/                  301',
        '/sdk/v0.19/        /sdk/v0.19/index.html        200',
      ].join('\n'),
    );
  });

  it('does not disturb another collection', () => {
    expect(cutRedirects(redirects, 'sdk', 'v0.20')).toContain(
      '/cli/v0.13/        /cli/v0.13/index.html        200',
    );
  });

  it('refuses to add a pair that is already there', () => {
    expect(() => cutRedirects(redirects, 'sdk', 'v0.19')).toThrow(
      /already carries/,
    );
  });
});

describe('the currency marker', () => {
  const page = '---\ntitle: API Summary — v0.20.x (latest)\nicon: Code\n---\n\n# Body\n';

  it('is cleared from the line being preserved', () => {
    expect(relabelTitle(page, 'v0.20', null)).toContain(
      'title: API Summary — v0.20.x\n',
    );
  });

  it('moves to the line being opened, with its number', () => {
    expect(relabelTitle(page, 'v0.20', 'v0.21')).toContain(
      'title: API Summary — v0.21.x (latest)\n',
    );
  });

  it('leaves the body and the rest of the frontmatter alone', () => {
    const relabelled = relabelTitle(page, 'v0.20', 'v0.21')!;
    expect(relabelled).toContain('icon: Code');
    expect(relabelled).toContain('# Body');
  });

  it('reports a page that claims nothing, rather than rewriting it', () => {
    expect(relabelTitle('---\ntitle: Quickstart\n---\n', 'v0.20', null)).toBeNull();
  });
});

describe('a cut against a copy of the tree', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof cutLine>>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'cut-line-'));
    for (const relative of [
      path.join('content', 'docs', 'sdk'),
      path.join('src', 'lib', 'versions.ts'),
      path.join('public', '_redirects'),
    ]) {
      const to = path.join(root, relative);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(path.join(WEBSITE, relative), to, { recursive: true });
    }
    result = await cutLine({ root, slug: 'sdk', version: NEXT });
  }, 30_000);

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('preserves the outgoing line under its plain folder', async () => {
    await expect(
      fs.stat(path.join(root, 'content', 'docs', 'sdk', CURRENT)),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(root, 'content', 'docs', 'sdk', `(${CURRENT})`)),
    ).rejects.toThrow();
  });

  it('opens the new line complete, at the same paths', async () => {
    const pagesOf = async (folder: string) =>
      (
        await fs.readdir(path.join(root, 'content', 'docs', 'sdk', folder), {
          recursive: true,
        })
      ).sort();
    expect(await pagesOf(`(${NEXT})`)).toEqual(await pagesOf(CURRENT));
  });

  it('declares both lines in the manifest, the new one current', async () => {
    const manifest = await fs.readFile(
      path.join(root, 'src', 'lib', 'versions.ts'),
      'utf-8',
    );
    expect(manifest).toContain(`{ version: '${NEXT}', folder: '(${NEXT})' }`);
    expect(manifest).toContain(`{ version: '${CURRENT}', folder: '${CURRENT}' }`);
  });

  it("adds the preserved line's index pair", async () => {
    const redirects = await fs.readFile(
      path.join(root, 'public', '_redirects'),
      'utf-8',
    );
    expect(redirects).toContain(`/sdk/${CURRENT}/index.html`);
    expect(redirects).toContain(`/sdk/${CURRENT}         /sdk/${CURRENT}/`);
  });

  it('moves the currency marker from the preserved line to the opened one', async () => {
    const titleIn = async (folder: string) =>
      (
        await fs.readFile(
          path.join(root, 'content', 'docs', 'sdk', folder, 'reference', 'api.mdx'),
          'utf-8',
        )
      )
        .split('\n')
        .find((line) => line.startsWith('title:'));

    expect(await titleIn(CURRENT)).toBe(`title: API Summary — ${CURRENT}.x`);
    expect(await titleIn(`(${NEXT})`)).toBe(
      `title: API Summary — ${NEXT}.x (latest)`,
    );
  });

  it('reports what it changed', () => {
    expect(result.preserved).toBe(CURRENT);
    expect(result.opened).toBe(NEXT);
    expect(result.changed).toContain(path.join('src', 'lib', 'versions.ts'));
    expect(result.changed).toContain(path.join('public', '_redirects'));
  });
});

describe('a cut it cannot make reviewable', () => {
  const against = (slug: string, version: string) =>
    cutLine({ root: path.join(tmpdir(), 'cut-line-unreachable'), slug, version });

  it('refuses a collection that is not versioned', async () => {
    await expect(against('resources', NEXT)).rejects.toThrow(
      /not a versioned collection/,
    );
  });

  it('names the collections that can be cut', async () => {
    await expect(against('resources', NEXT)).rejects.toThrow(/sdk, cli/);
  });

  it('refuses a version carrying a patch', async () => {
    await expect(against('sdk', `${NEXT}.0`)).rejects.toThrow(
      /does not name a line/,
    );
  });

  it('refuses a version that is not above the current line', async () => {
    await expect(against('sdk', CURRENT)).rejects.toThrow(/is not above/);
  });

  it('refuses a destination already on disk', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'cut-line-occupied-'));
    // Only the folder a cut would create: the refusal has to land before the
    // manifest is even read, so nothing else needs to be there.
    await fs.mkdir(path.join(root, 'content', 'docs', 'sdk', CURRENT), {
      recursive: true,
    });
    await expect(cutLine({ root, slug: 'sdk', version: NEXT })).rejects.toThrow(
      /already exists/,
    );
    await fs.rm(root, { recursive: true, force: true });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  cutLine,
  cutManifest,
  cutRedirects,
  emptyReleaseNotes,
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

describe('the line rules', () => {
  const redirects = [
    '# a comment',
    '/sdk/v0.19/        /sdk/v0.19/index.html        200',
    '/sdk/v0.19         /sdk/v0.19/                  301',
    '/sdk/v0.19/*       /sdk/v0.19/:splat/index.html 200',
    '/cli/v0.13/        /cli/v0.13/index.html        200',
    '/cli/v0.13         /cli/v0.13/                  301',
    '/cli/v0.13/*       /cli/v0.13/:splat/index.html 200',
    '',
  ].join('\n');

  it('go at the head of their own collection, in the block format', () => {
    expect(cutRedirects(redirects, 'sdk', 'v0.20')).toContain(
      [
        '/sdk/v0.20/        /sdk/v0.20/index.html        200',
        '/sdk/v0.20         /sdk/v0.20/                  301',
        '/sdk/v0.20/*       /sdk/v0.20/:splat/index.html 200',
        '/sdk/v0.19/        /sdk/v0.19/index.html        200',
      ].join('\n'),
    );
  });

  it('do not disturb another collection', () => {
    expect(cutRedirects(redirects, 'sdk', 'v0.20')).toContain(
      [
        '/cli/v0.13/        /cli/v0.13/index.html        200',
        '/cli/v0.13         /cli/v0.13/                  301',
        '/cli/v0.13/*       /cli/v0.13/:splat/index.html 200',
      ].join('\n'),
    );
  });

  it("sit below every other collection's rules on a collection's first cut", () => {
    const cut = cutRedirects(redirects, 'ecosystem', 'v1.0').split('\n');
    expect(cut.indexOf('/ecosystem/v1.0/   /ecosystem/v1.0/index.html   200')).toBe(
      cut.indexOf('/cli/v0.13/*       /cli/v0.13/:splat/index.html 200') + 1,
    );
  });

  it('refuse to add a line that is already there', () => {
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

describe('the release notes of the line being opened', () => {
  const page = [
    '---',
    'title: SDK Release Notes — v0.21.x (latest)',
    'sidebarTitle: Release notes',
    'icon: Tag',
    'description: Release notes for QVAC SDK v0.20.3.',
    '---',
    '',
    '## v0.20.3',
    '',
    'What the previous line shipped.',
    '',
  ].join('\n');

  const emptied = emptyReleaseNotes(page, 'v0.21', '@qvac/sdk')!;

  it('drops the previous line\'s notes, which it shares nothing with', () => {
    expect(emptied).not.toContain('## v0.20.3');
    expect(emptied).not.toContain('What the previous line shipped.');
  });

  it('keeps the frontmatter, so the page stays in the sidebar', () => {
    expect(emptied).toContain('title: SDK Release Notes — v0.21.x (latest)');
    expect(emptied).toContain('sidebarTitle: Release notes');
    expect(emptied).toContain('icon: Tag');
  });

  it('describes the line it opens, not the release it copied', () => {
    expect(emptied).toContain('description: Release notes for @qvac/sdk v0.21.');
    expect(emptied).not.toContain('v0.20.3.');
  });

  it('says the line has not shipped, rather than rendering blank', () => {
    expect(emptied).toContain('v0.21 has not been released yet.');
  });

  it('writes a description when the page carried none', () => {
    const bare = '---\ntitle: SDK Release Notes — v0.21.x\n---\n\n## v0.20.3\n';
    expect(emptyReleaseNotes(bare, 'v0.21', '@qvac/sdk')).toContain(
      'description: Release notes for @qvac/sdk v0.21.',
    );
  });

  it('reports a page with no frontmatter to keep, rather than emptying it', () => {
    expect(emptyReleaseNotes('## v0.20.3\n', 'v0.21', '@qvac/sdk')).toBeNull();
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

  it("adds the preserved line's rules", async () => {
    const redirects = await fs.readFile(
      path.join(root, 'public', '_redirects'),
      'utf-8',
    );
    expect(redirects).toContain(`/sdk/${CURRENT}/index.html`);
    expect(redirects).toContain(`/sdk/${CURRENT}         /sdk/${CURRENT}/`);
    expect(redirects).toContain(`/sdk/${CURRENT}/*       /sdk/${CURRENT}/:splat/index.html`);
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

  it('opens the line with empty release notes and the summary intact', async () => {
    const pageIn = (folder: string, page: string) =>
      fs.readFile(
        path.join(root, 'content', 'docs', 'sdk', folder, 'reference', page),
        'utf-8',
      );

    const notes = await pageIn(`(${NEXT})`, 'release-notes.mdx');
    expect(notes).toContain(`${NEXT} has not been released yet.`);
    expect(notes).toContain(`description: Release notes for @qvac/sdk ${NEXT}.`);
    expect(notes).not.toContain(`## ${CURRENT}.0`);

    // The summary is the opposite case: the release renders it over the copy,
    // and the diff against the previous line is what makes that review work.
    expect(await pageIn(`(${NEXT})`, 'api.mdx')).toBe(
      (await pageIn(CURRENT, 'api.mdx')).replace(
        `${CURRENT}.x`,
        `${NEXT}.x (latest)`,
      ),
    );
  });

  it('empties the opened line\'s notes only, never the preserved one\'s', async () => {
    const notes = (from: string, folder: string) =>
      fs.readFile(
        path.join(
          from, 'content', 'docs', 'sdk', folder, 'reference', 'release-notes.mdx',
        ),
        'utf-8',
      );
    const body = (page: string) => page.slice(page.indexOf('\n---\n') + 5);

    expect(body(await notes(root, CURRENT))).toBe(
      body(await notes(WEBSITE, `(${CURRENT})`)),
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

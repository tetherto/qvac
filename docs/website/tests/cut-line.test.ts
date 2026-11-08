import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  cutLine,
  cutManifest,
  relabelTitle,
  retargetReleaseNotesLink,
} from '../scripts/cut-line';
import { DEVELOPMENT_LINE } from '../scripts/lib/release-shared';
import { DOCUMENTED_SOFTWARE, toDocumentedSoftware } from '../src/lib/versions';
import { parseVersionsFile } from '../src/lib/versions-file';
import { publishedLineRules, publishedRules } from '../src/lib/line-redirects';

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
  (software) => software.path === '/sdk' && software.kind === 'product',
)!;
const CURRENT = sdk.versions.find((entry) => entry.folder.startsWith('('))!.version;
/** The line a cut would open next, derived so a real cut never dates this. */
const NEXT = (() => {
  const [major, minor] = CURRENT.replace(/^v/, '').split('.');
  return `v${major}.${Number(minor) + 1}`;
})();
const developmentDir = (root: string, slug = 'sdk') =>
  path.join(root, 'content', '_unpublished', slug, DEVELOPMENT_LINE);

describe('the manifest edit', () => {
  const manifest = JSON.stringify(
    {
      package: '@qvac/sdk',
      kind: 'product',
      path: '/sdk',
      paths: ['packages/sdk/docs/users'],
      retired: [],
      lines: [
        { version: 'v0.20', inPlace: true },
        { version: 'v0.19', inPlace: true },
      ],
    },
    null,
    2,
  );
  const linesOf = (text: string) =>
    (JSON.parse(text) as { lines: { version: string }[] }).lines.map(
      (line) => line.version,
    );

  it('declares the opened line first, which makes it current', () => {
    expect(linesOf(cutManifest(manifest, '/sdk', 'v0.20', 'v0.21'))).toEqual([
      'v0.21',
      'v0.20',
      'v0.19',
    ]);
  });

  it('retires nothing, however many lines the file declares', () => {
    const twice = cutManifest(cutManifest(manifest, '/sdk', 'v0.20', 'v0.21'), '/sdk', 'v0.21', 'v0.22');
    expect(linesOf(twice)).toEqual(['v0.22', 'v0.21', 'v0.20', 'v0.19']);
    expect(JSON.parse(twice).retired).toEqual([]);
  });

  it('refuses a collection the file does not document', () => {
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

describe('the release-notes link of the line being opened', () => {
  const meta = (tag: string) =>
    [
      '{',
      '  "title": "Reference",',
      '  "pages": [',
      '    "api",',
      `    "external:[Release Notes](https://github.com/tetherto/qvac/releases/tag/${tag})"`,
      '  ]',
      '}',
      '',
    ].join('\n');

  it('names the opened line\'s own tag, not the one it was copied from', () => {
    expect(
      retargetReleaseNotesLink(meta('sdk-v0.22.0'), 'sdk', 'v0.23'),
    ).toContain('/releases/tag/sdk-v0.23.0)');
  });

  it('leaves the rest of the entry alone', () => {
    const retargeted = retargetReleaseNotesLink(
      meta('sdk-v0.22.0'),
      'sdk',
      'v0.23',
    )!;
    expect(retargeted).toContain('"api"');
    expect(retargeted).toContain('external:[Release Notes](');
    expect(retargeted).not.toContain('sdk-v0.22.0');
  });

  it('reports a file carrying no such entry, which is every other collection', () => {
    const cli = '{\n  "title": "Reference",\n  "pages": ["api"]\n}\n';
    expect(retargetReleaseNotesLink(cli, 'cli', 'v0.18')).toBeNull();
  });

  it('matches the slug literally, so a metacharacter cannot stand for a letter', () => {
    expect(retargetReleaseNotesLink(meta('sdk-v0.22.0'), 'sd.', 'v0.23')).toBeNull();
  });
});

describe('a cut against a copy of the tree', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof cutLine>>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'cut-line-'));
    await copyTree(root);
    result = await cutLine({ root, slug: 'sdk', version: NEXT });
  }, 60_000);

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

  it('opens the released line carrying every page the preserved line has, at the same paths', async () => {
    const opened = await pagesOf(path.join(root, 'content', 'docs', 'sdk', `(${NEXT})`));
    const preserved = await pagesOf(path.join(root, 'content', 'docs', 'sdk', CURRENT));
    expect(preserved.filter((page) => !opened.includes(page))).toEqual([]);
  });

  it('leaves the development line in place, which is what makes the path stable', async () => {
    expect(await pagesOf(developmentDir(root))).toEqual(
      await pagesOf(path.join(root, 'content', 'docs', 'sdk', `(${NEXT})`)),
    );
  });

  it('declares the released line first in the versions file, the preserved one below it', async () => {
    const file = JSON.parse(
      await fs.readFile(path.join(root, 'versions', 'sdk.json'), 'utf-8'),
    ) as { lines: { version: string }[] };
    expect(file.lines.map((line) => line.version).slice(0, 2)).toEqual([NEXT, CURRENT]);
  });

  it("gives the preserved line its rules through the versions file, not the redirects", async () => {
    const declaration = parseVersionsFile(
      'sdk.json',
      JSON.parse(await fs.readFile(path.join(root, 'versions', 'sdk.json'), 'utf-8')),
    );
    const rules = publishedRules([toDocumentedSoftware(declaration)]);
    expect(rules).toContain(publishedLineRules('/sdk', CURRENT)[0]);
    expect(rules.some((rule) => rule.startsWith(`/sdk/${NEXT}`))).toBe(false);
  });

  it('moves the currency marker from the preserved line to the released one', async () => {
    expect(await titleIn(path.join(root, 'content', 'docs', 'sdk', CURRENT))).toBe(
      `title: API Summary — ${CURRENT}.x`,
    );
    expect(
      await titleIn(path.join(root, 'content', 'docs', 'sdk', `(${NEXT})`)),
    ).toBe(`title: API Summary — ${NEXT}.x (latest)`);
  });

  it('leaves the development line carrying the released marker, for the next cut to move', async () => {
    expect(await titleIn(developmentDir(root))).toBe(
      `title: API Summary — ${NEXT}.x (latest)`,
    );
  });

  it('opens the line with the summary the development line carried', async () => {
    const summaryOf = (dir: string) =>
      fs.readFile(path.join(dir, 'reference', 'api.mdx'), 'utf-8');

    expect(await summaryOf(path.join(root, 'content', 'docs', 'sdk', `(${NEXT})`))).toBe(
      await summaryOf(developmentDir(root)),
    );
  });

  it("points the released line's release-notes link at its own tag", async () => {
    expect(await tagIn(path.join(root, 'content', 'docs', 'sdk', `(${NEXT})`))).toBe(
      `sdk-${NEXT}.0`,
    );
    expect(await tagIn(path.join(root, 'content', 'docs', 'sdk', CURRENT))).toBe(
      `sdk-${CURRENT}.0`,
    );
    expect(await tagIn(developmentDir(root))).toBe(`sdk-${NEXT}.0`);
  });

  it('reports what it changed', () => {
    expect(result.released).toBe(NEXT);
    expect(result.preserved).toBe(CURRENT);
    expect(result.changed).toContain(path.join('versions', 'sdk.json'));
    expect(result.changed).not.toContain(path.join('public', '_redirects'));
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

  it('refuses a version below the line last cut', async () => {
    await expect(against('sdk', 'v0.1')).rejects.toThrow(/is not above/);
  });

  it('refuses to publish a line the development line cannot supply', async () => {
    await expect(against('sdk', NEXT)).rejects.toThrow(/no development line/);
  });

  it('refuses a destination already on disk', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'cut-line-occupied-'));
    // The development line a cut reads from, plus the one folder a cut would
    // create: the refusal has to land before the manifest is even read, so
    // nothing else needs to be there.
    await fs.mkdir(developmentDir(root), { recursive: true });
    await fs.mkdir(path.join(root, 'content', 'docs', 'sdk', CURRENT), {
      recursive: true,
    });
    await expect(cutLine({ root, slug: 'sdk', version: NEXT })).rejects.toThrow(
      /already exists/,
    );
    await fs.rm(root, { recursive: true, force: true });
  });
});

/** The pieces of the real tree a cut reads and writes. */
async function copyTree(root: string): Promise<void> {
  for (const relative of [
    path.join('content', 'docs', 'sdk'),
    path.join('content', '_unpublished', 'sdk', DEVELOPMENT_LINE),
    path.join('versions', 'sdk.json'),
    path.join('public', '_redirects'),
  ]) {
    const to = path.join(root, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(path.join(WEBSITE, relative), to, { recursive: true });
  }
}

async function pagesOf(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { recursive: true })).sort();
}

async function titleIn(dir: string): Promise<string | undefined> {
  return (await fs.readFile(path.join(dir, 'reference', 'api.mdx'), 'utf-8'))
    .split('\n')
    .find((line) => line.startsWith('title:'));
}

async function tagIn(dir: string): Promise<string | undefined> {
  return (
    await fs.readFile(path.join(dir, 'reference', 'meta.json'), 'utf-8')
  ).match(/\/releases\/tag\/([^)]+)\)/)?.[1];
}

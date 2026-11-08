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
import { DEVELOPMENT_LINE, developmentLineDir } from '../scripts/lib/release-shared';
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
  developmentLineDir(slug, root);
const legacyDevelopmentDir = (root: string, slug = 'sdk') =>
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
  // The CLI still keeps its development line under `content/_unpublished/`,
  // so it is the collection a cut still publishes. The SDK is published by
  // pinning (see the refusal below).
  const cli = DOCUMENTED_SOFTWARE.find((software) => software.path === '/cli')!;
  const CLI_CURRENT = cli.versions[0].version;
  const CLI_NEXT = (() => {
    const [major, minor] = CLI_CURRENT.replace(/^v/, '').split('.');
    return `v${major}.${Number(minor) + 1}`;
  })();
  let base: string;
  let root: string;
  let result: Awaited<ReturnType<typeof cutLine>>;

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(tmpdir(), 'cut-line-'));
    root = path.join(base, 'docs', 'website');
    await copyTree(root, 'cli');
    result = await cutLine({ root, slug: 'cli', version: CLI_NEXT });
  }, 60_000);

  afterAll(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it('preserves the outgoing line under its plain folder', async () => {
    await expect(
      fs.stat(path.join(root, 'content', 'docs', 'cli', CLI_CURRENT)),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(root, 'content', 'docs', 'cli', `(${CLI_CURRENT})`)),
    ).rejects.toThrow();
  });

  it('opens the released line as a copy of the development line', async () => {
    expect(await pagesOf(developmentDir(root, 'cli'))).toEqual(
      await pagesOf(path.join(root, 'content', 'docs', 'cli', `(${CLI_NEXT})`)),
    );
  });

  it('declares the released line first in the versions file, the preserved one below it', async () => {
    const file = JSON.parse(
      await fs.readFile(path.join(root, 'versions', 'cli.json'), 'utf-8'),
    ) as { lines: { version: string }[] };
    expect(file.lines.map((line) => line.version).slice(0, 2)).toEqual([CLI_NEXT, CLI_CURRENT]);
  });

  it("gives the preserved line its rules through the versions file, not the redirects", async () => {
    const declaration = parseVersionsFile(
      'cli.json',
      JSON.parse(await fs.readFile(path.join(root, 'versions', 'cli.json'), 'utf-8')),
    );
    const rules = publishedRules([toDocumentedSoftware(declaration)]);
    expect(rules).toContain(publishedLineRules('/cli', CLI_CURRENT)[0]);
    expect(rules.some((rule) => rule.startsWith(`/cli/${CLI_NEXT}`))).toBe(false);
  });

  it('reports what it changed', () => {
    expect(result.released).toBe(CLI_NEXT);
    expect(result.preserved).toBe(CLI_CURRENT);
    expect(result.changed).toContain(path.join('versions', 'cli.json'));
    expect(result.changed).not.toContain(path.join('public', '_redirects'));
  });
});

describe('a collection published by pinning', () => {
  it('refuses the SDK, whose documentation lives in its package', async () => {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'cut-line-sdk-'));
    const root = path.join(base, 'docs', 'website');
    await copyTree(root, 'sdk');
    await expect(cutLine({ root, slug: 'sdk', version: NEXT })).rejects.toThrow(
      /keeps its documentation in its package/,
    );
    await fs.rm(base, { recursive: true, force: true });
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
    await fs.mkdir(legacyDevelopmentDir(root), { recursive: true });
    await fs.mkdir(path.join(root, 'content', 'docs', 'sdk', CURRENT), {
      recursive: true,
    });
    await expect(cutLine({ root, slug: 'sdk', version: NEXT })).rejects.toThrow(
      /already exists/,
    );
    await fs.rm(root, { recursive: true, force: true });
  });
});

/** The pieces of the real tree a cut of `slug` reads and writes. */
async function copyTree(root: string, slug: string): Promise<void> {
  for (const relative of [
    path.join('content', 'docs', slug),
    path.join('versions', `${slug}.json`),
    path.join('public', '_redirects'),
  ]) {
    const to = path.join(root, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(path.join(WEBSITE, relative), to, { recursive: true, verbatimSymlinks: true });
  }
  const development = developmentLineDir(slug);
  const target = path.join(root, path.relative(WEBSITE, development));
  await fs.mkdir(target, { recursive: true });
  await fs.cp(development, target, { recursive: true });
}

async function pagesOf(dir: string): Promise<string[]> {
  return (await fs.readdir(dir, { recursive: true })).sort();
}



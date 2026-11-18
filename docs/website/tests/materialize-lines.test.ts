import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { materializeLines, parseOverride, planLines } from '../scripts/materialize-lines'
import { checkVersionStructure } from '../src/lib/version-structure'
import { parseVersionsFile } from '../src/lib/versions-file'
import { toDocumentedSoftware } from '../src/lib/versions'

/**
 * Materialization against a throwaway repository: two commits documenting a
 * `demo` package, each with a different version of the same example. Each
 * line must render the example of its own commit.
 */

let repo: string
let website: string
let older: string
let newer: string

const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()

async function write(relative: string, content: string): Promise<void> {
  const file = path.join(repo, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function commit(message: string): Promise<string> {
  git('add', '-A')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message)
  return git('rev-parse', 'HEAD')
}

function demoFile(lines: unknown[]) {
  return {
    'demo.json': {
      package: '@qvac/demo',
      kind: 'product',
      path: '/demo',
      paths: ['packages/demo/docs/users', 'packages/demo/examples'],
      lines,
    },
  }
}

const options = () => ({ websiteRoot: website, monorepoRoot: repo, monorepoUrl: repo, log: () => {} })

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(tmpdir(), 'materialize-repo-'))
  website = await fs.mkdtemp(path.join(tmpdir(), 'materialize-site-'))
  execFileSync('git', ['init', '--quiet', repo])

  await write('packages/demo/docs/users/meta.json', '{ "title": "Demo", "pages": ["index"] }\n')
  await write('packages/demo/docs/users/index.mdx', '---\ntitle: Demo\n---\n\nv1.0 page\n')
  await write('packages/demo/examples/hello.ts', 'export const greeting: string = "old"\n')
  await write('packages/demo/examples/data.txt', 'asset\n')
  older = await commit('v1.0')

  await write('packages/demo/docs/users/index.mdx', '---\ntitle: Demo\n---\n\nv1.1 page\n')
  await write('packages/demo/examples/hello.ts', 'export const greeting: string = "new"\n')
  newer = await commit('v1.1')
}, 60_000)

afterAll(async () => {
  await fs.rm(repo, { recursive: true, force: true })
  await fs.rm(website, { recursive: true, force: true })
})

describe('materializing pinned lines', () => {
  beforeAll(async () => {
    await materializeLines({
      ...options(),
      files: demoFile([
        { version: 'v1.1', ref: 'release-demo-1.1.0', sha: newer },
        { version: 'v1.0', ref: 'release-demo-1.0.0', sha: older },
      ]),
    })
  }, 120_000)

  it('writes the current line as the folder group and the other as a version folder', () => {
    expect(existsSync(path.join(website, 'content/docs/demo/(v1.1)/index.mdx'))).toBe(true)
    expect(existsSync(path.join(website, 'content/docs/demo/v1.0/index.mdx'))).toBe(true)
  })

  it("renders each line's pages from its own commit", async () => {
    const current = await fs.readFile(path.join(website, 'content/docs/demo/(v1.1)/index.mdx'), 'utf-8')
    const previous = await fs.readFile(path.join(website, 'content/docs/demo/v1.0/index.mdx'), 'utf-8')
    expect(current).toContain('v1.1 page')
    expect(previous).toContain('v1.0 page')
  })

  it("keeps each line's examples as they stood at its commit", async () => {
    const example = (version: string) =>
      fs.readFile(path.join(website, `.lines/demo/${version}/packages/demo/examples/hello.ts`), 'utf-8')
    expect(await example('v1.0')).toContain('"old"')
    expect(await example('v1.1')).toContain('"new"')
  })

  it('transpiles the examples and copies their assets beside them', async () => {
    const dist = path.join(website, '.lines/demo/v1.0/packages/demo/dist/examples')
    expect(await fs.readFile(path.join(dist, 'hello.js'), 'utf-8')).toContain('"old"')
    expect(existsSync(path.join(dist, 'data.txt'))).toBe(true)
  })

  it('passes the structure check the site applies to every line', () => {
    const files = demoFile([
      { version: 'v1.1', ref: 'release-demo-1.1.0', sha: newer },
      { version: 'v1.0', ref: 'release-demo-1.0.0', sha: older },
    ])
    const software = toDocumentedSoftware(parseVersionsFile('demo.json', files['demo.json']))
    const entries = readdirSync(path.join(website, 'content/docs/demo'), { withFileTypes: true })
    const listing = {
      directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      files: entries.filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name)).map((entry) => entry.name),
      symlinks: entries.filter((entry) => entry.isSymbolicLink()).map((entry) => entry.name),
    }
    expect(checkVersionStructure(new Map([['/demo', listing]]), [software])).toEqual([])
  })

  it('marks a materialized folder and keeps it out of git', async () => {
    const folder = path.join(website, 'content/docs/demo/v1.0')
    expect(existsSync(path.join(folder, '.materialized'))).toBe(true)
    expect(await fs.readFile(path.join(folder, '.gitignore'), 'utf-8')).toBe('*\n')
  })

  it('removes a line that is no longer declared, and moves currency with the declaration', async () => {
    await materializeLines({
      ...options(),
      files: demoFile([{ version: 'v1.0', ref: 'release-demo-1.0.0', sha: older }]),
    })
    expect(existsSync(path.join(website, 'content/docs/demo/(v1.1)'))).toBe(false)
    expect(existsSync(path.join(website, 'content/docs/demo/(v1.0)/index.mdx'))).toBe(true)
    expect(existsSync(path.join(website, 'content/docs/demo/v1.0'))).toBe(false)
  }, 120_000)
})

describe('a line that cannot be materialized', () => {
  it('names a pin whose commit has no documentation', async () => {
    const bare = git('commit-tree', git('mktree', '--missing'), '-m', 'empty')
    await expect(
      materializeLines({
        ...options(),
        files: demoFile([{ version: 'v0.9', ref: 'release-demo-0.9.0', sha: bare }]),
      }),
    ).rejects.toThrow(/demo v0\.9 is pinned to [0-9a-f]+, which has no packages\/demo\/docs\/users/)
  })

  it('names a commit that cannot be fetched', async () => {
    await expect(
      materializeLines({
        ...options(),
        files: demoFile([{ version: 'v0.9', ref: 'release-demo-0.9.0', sha: 'f'.repeat(40) }]),
      }),
    ).rejects.toThrow(/demo v0\.9: commit f+ cannot be fetched/)
  }, 60_000)

  it('refuses to overwrite a folder it did not materialize', async () => {
    const own = path.join(website, 'content/docs/demo/(v2.0)')
    await fs.mkdir(own, { recursive: true })
    await expect(
      materializeLines({
        ...options(),
        files: demoFile([{ version: 'v2.0', ref: 'release-demo-2.0.0', sha: newer }]),
      }),
    ).rejects.toThrow(/was not materialized/)
    await fs.rm(own, { recursive: true, force: true })
  }, 60_000)
})

describe('overrides and the unreleased line', () => {
  it('parses an override and rejects a malformed one', () => {
    expect(parseOverride('sdk@v0.24=abc1234')).toEqual(['sdk@v0.24', 'abc1234'])
    expect(() => parseOverride('sdk=abc1234')).toThrow(/expects/)
  })

  it('substitutes a declared line with a working tree', () => {
    const [line] = planLines({
      ...options(),
      files: demoFile([{ version: 'v1.1', ref: 'release-demo-1.1.0', sha: newer }]),
      overrides: { 'demo@v1.1': repo },
    })
    expect(line.source).toEqual({ kind: 'tree', root: repo })
  })

  it('substitutes an in-place line, so a migration can be previewed', () => {
    const [line] = planLines({
      ...options(),
      files: demoFile([{ version: 'v1.1', inPlace: true }]),
      overrides: { 'demo@v1.1': repo },
    })
    expect(line.folder).toBe('(v1.1)')
  })

  it('refuses an override naming an undeclared line', () => {
    expect(() =>
      planLines({
        ...options(),
        files: demoFile([{ version: 'v1.1', ref: 'release-demo-1.1.0', sha: newer }]),
        overrides: { 'demo@v9.9': repo },
      }),
    ).toThrow(/undeclared lines: demo@v9\.9/)
  })

  it('adds no preview for a software whose documentation is not in its package yet', () => {
    const files = { 'other.json': { ...demoFile([{ version: 'v1.1', inPlace: true }])['demo.json'], path: '/other', paths: ['packages/other/docs/users'] } }
    expect(planLines({ ...options(), files, includeDev: true })).toEqual([])
  })

  it('adds the unreleased line as preview only when asked', () => {
    const files = demoFile([{ version: 'v1.1', inPlace: true }])
    expect(planLines({ ...options(), files })).toEqual([])
    const [dev] = planLines({ ...options(), files, includeDev: true })
    expect(dev).toMatchObject({ folder: 'preview', source: { kind: 'tree', root: repo } })
  })
})

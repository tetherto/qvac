import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import remarkLineRoots, { snapshotRootOf } from '../src/lib/remark-line-roots'

/**
 * A materialized line imports its examples from its own snapshot; a line held
 * in place keeps importing from the monorepo root.
 */

let website: string
const monorepo = () => path.resolve(website, '../..')

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'line-roots-'))
  website = path.join(base, 'docs', 'website')
  await fs.mkdir(path.join(website, '.lines', 'sdk', 'v0.22'), { recursive: true })
})

afterAll(async () => {
  await fs.rm(path.resolve(website, '../..'), { recursive: true, force: true })
})

const page = (folder: string) => path.join(website, 'content', 'docs', 'sdk', folder, 'page.mdx')

describe('the snapshot a page belongs to', () => {
  it('is the line snapshot when the line was materialized', () => {
    expect(snapshotRootOf(page('v0.22'), website)).toBe(path.join(website, '.lines', 'sdk', 'v0.22'))
  })

  it('reads the current line through its folder group', async () => {
    await fs.mkdir(path.join(website, '.lines', 'sdk', 'v0.30'), { recursive: true })
    expect(snapshotRootOf(page('(v0.30)'), website)).toBe(path.join(website, '.lines', 'sdk', 'v0.30'))
  })

  it('is none for a line held in place', () => {
    expect(snapshotRootOf(page('v0.21'), website)).toBeNull()
  })

  it('is none outside a documented software', () => {
    expect(snapshotRootOf(path.join(website, 'content', 'docs', 'resources', 'x.mdx'), website)).toBeNull()
  })
})

describe('the rewrite', () => {
  const tree = () => ({
    type: 'root',
    children: [
      { type: 'code', meta: 'file=<rootDir>/packages/sdk/examples/a.ts title="a.ts"' },
      { type: 'code', meta: 'title="inline"' },
    ],
  })

  it('roots a materialized line at its snapshot', () => {
    const root = tree()
    remarkLineRoots({ websiteRoot: website, monorepoRoot: monorepo() })(root, { path: page('v0.22') })
    expect(root.children[0].meta).toBe(
      'file=<rootDir>/docs/website/.lines/sdk/v0.22/packages/sdk/examples/a.ts title="a.ts"',
    )
    expect(root.children[1].meta).toBe('title="inline"')
  })

  it('leaves a line held in place as written', () => {
    const root = tree()
    remarkLineRoots({ websiteRoot: website, monorepoRoot: monorepo() })(root, { path: page('v0.21') })
    expect(root.children[0].meta).toBe('file=<rootDir>/packages/sdk/examples/a.ts title="a.ts"')
  })
})

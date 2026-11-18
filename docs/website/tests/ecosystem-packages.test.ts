/**
 * The Packages mechanism, exercised on a fixture package
 * (`tests/fixtures/platform-package/`): how a `platform` versions file is
 * versioned, materialized, and composed into Ecosystem; the TypeDoc
 * normalizer that writes its API reference; the contract its pages must meet;
 * and its whole-surface binding. No real package is documented yet, so the
 * fixture is what proves a first one would work.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/resolveIcon', () => ({ resolveIcon: () => undefined }))

import { searchPath } from 'fumadocs-core/breadcrumb'
import type { Node, Root } from 'fumadocs-core/page-tree'
import { generatePackageApi } from '../scripts/api-reference/generate-package-api'
import { checkBindings, lockFor, scanPages } from '../scripts/bindings/bindings'
import { projectSurface } from '../scripts/bindings/surface'
import { checkContract, readKinds } from '../scripts/contract/check-contract'
import { planLines } from '../scripts/materialize-lines'
import { packageRoots, packagesSection } from '@/lib/custom-tree'
import type { PackageApi } from '@/lib/api-reference/package-api'
import { computeSectionVersionUrl, documentedSoftwareFrom } from '@/lib/versions'
import { parseVersionsFile } from '@/lib/versions-file'

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'platform-package')
const FIXTURE_FROM_MONOREPO = 'docs/website/tests/fixtures/platform-package'
const DOCS_ROOT = path.join(FIXTURE, 'docs', 'users')
const SHA = 'c'.repeat(40)

const declaration = {
  package: '@qvac/fixture-platform',
  kind: 'platform',
  path: '/ecosystem/packages/fixture-platform',
  paths: [`${FIXTURE_FROM_MONOREPO}/docs/users`],
  lines: [
    { version: 'v1.4', ref: 'release-fixture-platform-1.4.2', sha: SHA },
    { version: 'v1.3', ref: 'release-fixture-platform-1.3.0', sha: SHA },
  ],
}

const [software] = documentedSoftwareFrom({ 'fixture-platform.json': declaration })

describe('a package is versioned like a collection', () => {
  it('makes its newest line current, served version-less', () => {
    expect(software.versions).toEqual([
      { version: 'v1.4', folder: '(v1.4)' },
      { version: 'v1.3', folder: 'v1.3' },
    ])
    expect(computeSectionVersionUrl(software.path, 'v1.4', 'v1.4')).toBe('/ecosystem/packages/fixture-platform/')
    expect(computeSectionVersionUrl(software.path, 'v1.3', 'v1.4')).toBe('/ecosystem/packages/fixture-platform/v1.3/')
  })

  it('materializes its lines under its path inside Ecosystem', () => {
    const planned = planLines({ files: { 'fixture-platform.json': declaration } })
    expect(planned.map((line) => [line.slug, line.folder])).toEqual([
      ['ecosystem/packages/fixture-platform', '(v1.4)'],
      ['ecosystem/packages/fixture-platform', 'v1.3'],
    ])
  })

  it('publishes nothing before a release pins its first line', () => {
    expect(parseVersionsFile('new.json', { ...declaration, lines: [] }).lines).toEqual([])
    expect(documentedSoftwareFrom({ 'new.json': { ...declaration, lines: [] } })).toEqual([])
  })
})

describe('Packages in the Ecosystem navigation', () => {
  const pageTree: Root = {
    $id: 'root',
    name: 'docs',
    children: software.versions.map((line): Node => ({
      type: 'folder',
      $id: `ecosystem/packages/fixture-platform/${line.folder}`,
      name: line.version,
      children: [
        {
          type: 'page',
          name: 'Usage',
          url: line.folder.startsWith('(')
            ? '/ecosystem/packages/fixture-platform/usage'
            : `/ecosystem/packages/fixture-platform/${line.version}/usage`,
        },
      ],
    })),
  }

  it('is hidden while no package is declared', () => {
    expect(packagesSection([])).toEqual([])
  })

  it('lists one entry per package, entered at its current line', () => {
    const [section] = packagesSection([software])
    expect(section).toMatchObject({ type: 'folder', name: 'Packages' })
    if (section.type !== 'folder') throw new Error('a folder expected')
    expect(section.children).toEqual([{ type: 'page', name: 'fixture-platform', url: '/ecosystem/packages/fixture-platform' }])
  })

  it('draws the Ecosystem sidebar on every page of every line, with the package open', () => {
    const roots = packageRoots(pageTree, [software])
    expect(roots).toHaveLength(2)
    for (const pathname of ['/ecosystem/packages/fixture-platform/usage', '/ecosystem/packages/fixture-platform/v1.3/usage']) {
      const found = searchPath(roots, pathname) ?? []
      expect(found.some((node) => node.type === 'folder' && node.root), `${pathname} has no sidebar`).toBe(true)
      expect(found.some((node) => node.type === 'folder' && node.name === 'fixture-platform')).toBe(true)
    }
  })
})

describe('the TypeDoc normalizer', () => {
  const api = JSON.parse(readFileSync(path.join(DOCS_ROOT, '_generated', 'api.json'), 'utf-8')) as PackageApi
  const find = (name: string) => api.exports.find((entry) => entry.name === name)!

  it('writes the committed data, byte for byte', async () => {
    expect(await generatePackageApi(FIXTURE_FROM_MONOREPO, { check: true })).toEqual([])
  }, 30_000)

  it('keeps one signature per overload, with parameter and return descriptions', () => {
    const translate = find('translate')
    expect(translate.signatures?.map((signature) => signature.text)).toEqual([
      'translate(text: string, options: TranslateOptions): Promise<Translation>',
      'translate(texts: string[], options: TranslateOptions): Promise<Translation[]>',
    ])
    expect(translate.signatures?.[0].parameters[0]).toMatchObject({ name: 'text', description: 'The text to translate.' })
    expect(translate.signatures?.[0].returns.description).toBe('The translation.')
  })

  it('expands interfaces and object aliases into fields, and literal unions and enums into values', () => {
    expect(find('TranslateOptions').fields?.map((field) => `${field.name}${field.optional ? '?' : ''}: ${field.type}`)).toEqual([
      'from?: string',
      'mode?: LoadMode',
      'to: string',
    ])
    expect(find('Translation').fields?.map((field) => field.name)).toEqual(['text', 'tokens'])
    expect(find('LoadMode').values).toEqual(['"eager"', '"lazy"'])
    expect(find('LogLevel').values).toEqual(['Error = 0', 'Info = 1'])
  })

  it('documents a class by its constructor, properties, and methods, and marks deprecation', () => {
    const translator = find('Translator')
    expect(translator.signatures?.[0].text).toBe('new Translator(path: string): Translator')
    expect(translator.fields?.map((field) => field.name)).toEqual(['path'])
    expect(translator.methods?.map((method) => method.name)).toEqual(['unload'])
    expect(find('legacyTranslate').deprecated).toBe('Use `translate`.')
  })

})

describe('the docs contract of a platform package', () => {
  const kinds = readKinds()
  const parsed = parseVersionsFile('fixture-platform.json', declaration)

  function copy(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'contract-'))
    cpSync(DOCS_ROOT, root, { recursive: true })
    return root
  }

  it('passes the fixture, which carries every required page', () => {
    expect(checkContract(parsed, DOCS_ROOT, kinds, ['/sdk', '/cli'])).toEqual([])
  })

  it('names a missing required page', () => {
    const root = copy()
    rmSync(path.join(root, 'installation.mdx'))
    expect(checkContract(parsed, root, kinds, ['/sdk'])).toEqual([
      expect.stringContaining('missing the installation page'),
    ])
  })

  it('requires the API reference to bind the whole surface', () => {
    const root = copy()
    writeFileSync(path.join(root, 'api.mdx'), '---\ntitle: API\n---\n\nWritten by hand, bound to nothing.\n')
    expect(checkContract(parsed, root, kinds, ['/sdk'])).toEqual([expect.stringContaining('does not bind `surface`')])
  })

  it('requires the overview to link the canonical product', () => {
    const root = copy()
    writeFileSync(path.join(root, 'index.mdx'), '---\ntitle: Fixture\n---\n\nNo product named.\n')
    expect(checkContract(parsed, root, kinds, ['/sdk'])).toEqual([expect.stringContaining('links no product')])
  })

  it('requires nothing of a product', () => {
    expect(checkContract({ ...parsed, kind: 'product' }, DOCS_ROOT, kinds, [])).toEqual([])
  })
})

describe('the whole-surface binding of a platform package', () => {
  const surface = projectSurface({ root: path.resolve(FIXTURE, '..', '..', '..', '..', '..'), paths: declaration.paths })

  it('projects every export of the normalized API', () => {
    expect([...surface.keys()].filter((id) => id.startsWith('export:')).sort()).toEqual([
      'export:ENGINE_VERSION',
      'export:legacyTranslate',
      'export:LoadMode',
      'export:LogLevel',
      'export:translate',
      'export:TranslateOptions',
      'export:Translation',
      'export:Translator',
    ].sort())
  })

  it('names every page bound to the surface when any export changes, and asks for no coverage', () => {
    const scan = scanPages(DOCS_ROOT)
    const lock = lockFor(scan.bindings, surface)
    expect(checkBindings({ kind: 'platform', surface, scan, lock })).toEqual([])

    const changed = new Map(surface)
    changed.set('export:translate', { changed: true })
    expect(checkBindings({ kind: 'platform', surface: changed, scan, lock }).map((problem) => `${problem.kind} ${problem.page}`)).toEqual([
      'drift api.mdx',
      'drift usage.mdx',
    ])
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  selectExportTarget,
  createSdkImportResolver
} from "@/commands/bundle/resolve-sdk-import";
import { generateWorkerEntry } from "@/commands/bundle/entry-gen";

describe('selectExportTarget', () => {
  it('returns a plain string target', () => {
    assert.equal(selectExportTarget('./dist/index.js'), './dist/index.js')
  })

  it('resolves the import condition', () => {
    assert.equal(selectExportTarget({ import: './dist/x.js' }), './dist/x.js')
  })

  it('prefers the bare condition over import', () => {
    assert.equal(
      selectExportTarget({ import: './dist/x.js', bare: './dist/x.bare.js' }),
      './dist/x.bare.js'
    )
  })

  it('descends into nested conditions', () => {
    assert.equal(
      selectExportTarget({ node: { import: './dist/node.js' } }),
      './dist/node.js'
    )
  })

  it('returns null for missing or unknown-only conditions', () => {
    assert.equal(selectExportTarget(undefined), null)
    assert.equal(selectExportTarget({ types: './dist/x.d.ts' }), null)
  })
})

describe('createSdkImportResolver', () => {
  function fakeSdk(t: { after: (fn: () => void) => void }): {
    realDir: string
    linkDir: string
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-sdk-import-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const realDir = path.join(root, 'real', 'sdk')
    fs.mkdirSync(realDir, { recursive: true })
    fs.writeFileSync(
      path.join(realDir, 'package.json'),
      JSON.stringify({
        name: '@qvac/sdk',
        exports: {
          './worker-core': { import: './dist/server/worker-core.js' },
          './plugins': { import: './dist/server/plugins/index.js' }
        }
      })
    )
    const linkDir = path.join(root, 'node_modules', '@qvac', 'sdk')
    fs.mkdirSync(path.dirname(linkDir), { recursive: true })
    fs.symlinkSync(realDir, linkDir)
    return { realDir, linkDir }
  }

  it('resolves an SDK subpath to a file URL anchored at the realpath, not the symlink', (t) => {
    const { realDir, linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')

    const expected = pathToFileURL(
      path.join(fs.realpathSync(realDir), 'dist', 'server', 'worker-core.js')
    ).href
    assert.equal(resolve('@qvac/sdk/worker-core'), expected)
    assert.ok(!resolve('@qvac/sdk/worker-core').includes('node_modules'))
  })

  it('passes through non-SDK specifiers unchanged', (t) => {
    const { linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')
    assert.equal(resolve('react'), 'react')
    assert.equal(resolve('my-pkg/plugin'), 'my-pkg/plugin')
  })

  it('leaves SDK subpaths that are not in exports unchanged', (t) => {
    const { linkDir } = fakeSdk(t)
    const resolve = createSdkImportResolver(linkDir, '@qvac/sdk')
    assert.equal(resolve('@qvac/sdk/not-exported'), '@qvac/sdk/not-exported')
  })
})

describe('generateWorkerEntry', () => {
  const tag = (specifier: string): string =>
    specifier.startsWith('@qvac/sdk') ? `RESOLVED:${specifier}` : specifier

  it('routes SDK core imports through the resolver', () => {
    const entry = generateWorkerEntry([], '@qvac/sdk', tag)
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/worker-core"/)
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/plugins"/)
    assert.match(entry, /from "RESOLVED:@qvac\/sdk\/logging"/)
  })

  it('routes builtin plugin imports through the resolver and keeps custom plugins', () => {
    const entry = generateWorkerEntry(
      ['@qvac/sdk/llamacpp-completion/plugin', 'my-pkg/plugin'],
      '@qvac/sdk',
      tag
    )
    assert.match(
      entry,
      /from "RESOLVED:@qvac\/sdk\/llamacpp-completion\/plugin"/
    )
    assert.match(entry, /from "my-pkg\/plugin"/)
  })

  it('defaults to an identity resolver (imports stay bare specifiers)', () => {
    const entry = generateWorkerEntry([], '@qvac/sdk')
    assert.match(entry, /from "@qvac\/sdk\/worker-core"/)
  })
})

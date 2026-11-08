import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PUBLISHED_MARKER,
  RETIRED_MARKER,
  expandLineRedirects,
  publishedRules,
  retiredRules,
} from '../src/lib/line-redirects'
import { DOCUMENTED_SOFTWARE, type DocumentedSoftware } from '../src/lib/versions'

/**
 * The redirect rules of every documentation line are generated from the
 * versions files and expanded into the exported `_redirects` at build, so
 * publishing or retiring a line is one edit to its versions file.
 */

const source = readFileSync(path.join(import.meta.dirname, '..', 'public', '_redirects'), 'utf-8')
const fields = (text: string) =>
  text.split('\n').map((line) => line.trim().split(/\s+/)).filter((f) => f.length >= 3 && f[0].startsWith('/'))

const demo: DocumentedSoftware = {
  package: '@qvac/demo',
  kind: 'user-facing',
  path: '/demo',
  versions: [
    { version: 'v1.2', folder: '(v1.2)' },
    { version: 'v1.1', folder: 'v1.1' },
  ],
  retired: ['v1.0'],
}

describe('the source redirects', () => {
  it('carries each marker once, and no hand-written line rule', () => {
    expect(source.split('\n').filter((line) => line.trim() === PUBLISHED_MARKER)).toHaveLength(1)
    expect(source.split('\n').filter((line) => line.trim() === RETIRED_MARKER)).toHaveLength(1)
    for (const software of DOCUMENTED_SOFTWARE) {
      expect(fields(source).filter(([from]) => from.startsWith(`${software.path}/v`))).toEqual([])
    }
  })
})

describe('the generated rules', () => {
  it('serve every published line except the current one', () => {
    const rules = fields(publishedRules([demo]).join('\n'))
    expect(rules.map(([from, to, status]) => [from, to, status])).toEqual([
      ['/demo/v1.1/', '/demo/v1.1/index.html', '200'],
      ['/demo/v1.1', '/demo/v1.1/', '301'],
      ['/demo/v1.1/*', '/demo/v1.1/:splat/index.html', '200'],
    ])
  })

  it('send every address of a retired line to the current line', () => {
    const rules = fields(retiredRules([demo]).join('\n'))
    expect(rules.map(([from, to, status]) => [from, to, status])).toEqual([
      ['/demo/v1.0/', '/demo/', '301'],
      ['/demo/v1.0', '/demo/', '301'],
      ['/demo/v1.0/*', '/demo/:splat', '301'],
    ])
  })

  it('serve every version of an internal-machinery package, whose bare path is its index', () => {
    const pkg: DocumentedSoftware = { ...demo, kind: 'internal-machinery', path: '/ecosystem/packages/demo',
      versions: [{ version: 'v1.2', folder: 'v1.2' }], retired: [] }
    expect(fields(publishedRules([pkg]).join('\n'))[0][0]).toBe('/ecosystem/packages/demo/v1.2/')
  })

  it('expand in place of the markers, keeping every other rule where it is', () => {
    const expanded = expandLineRedirects(`/a /b 301\n${PUBLISHED_MARKER}\n/c /d 301\n${RETIRED_MARKER}\n/* /404.html 404`, [demo])
    const sources = fields(expanded).map(([from]) => from)
    expect(sources[0]).toBe('/a')
    expect(sources.indexOf('/c')).toBe(4)
    expect(sources.at(-1)).toBe('/*')
  })

  it('refuse a file that lost a marker', () => {
    expect(() => expandLineRedirects('/a /b 301', [demo])).toThrow(/must carry the marker/)
  })

  it('never serve a retired line as published', () => {
    for (const software of DOCUMENTED_SOFTWARE) {
      for (const version of software.retired ?? []) {
        expect(publishedRules([software]).some((rule) => rule.includes(`${software.path}/${version}/index.html`))).toBe(false)
      }
    }
  })
})

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateLinks,
  extractInternalLinks,
  contentPathsOfLink,
} from '../scripts/lib/link-validator'
import { getDocumentedSoftware } from '../src/lib/versions'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEBSITE_DIR = path.resolve(TESTS_DIR, '..')
const DOCS_BASE = path.join(WEBSITE_DIR, 'content', 'docs')

// ---------------------------------------------------------------------------
// Unit tests for link extraction
// ---------------------------------------------------------------------------

describe('extractInternalLinks', () => {
  it('extracts href links', () => {
    expect(extractInternalLinks('see <a href="/sdk/quickstart">here</a>'))
      .toEqual(['/sdk/quickstart'])
  })

  it('extracts markdown links', () => {
    expect(extractInternalLinks('see [Errors](/reference/api/errors) for details'))
      .toEqual(['/reference/api/errors'])
  })

  it('strips hash fragments', () => {
    expect(extractInternalLinks('see [type](/reference/api/completion#completionparams)'))
      .toEqual(['/reference/api/completion'])
  })

  it('ignores pure hash links', () => {
    expect(extractInternalLinks('see [type](#completionparams)'))
      .toEqual([])
  })

  it('deduplicates links', () => {
    const content = '[a](/foo) and [b](/foo) and [c](/bar)'
    const links = extractInternalLinks(content)
    expect(links).toContain('/foo')
    expect(links).toContain('/bar')
    expect(links.filter((l) => l === '/foo')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// A link into a versioned collection names no line, so where it resolves
// depends on the page carrying it. These cover that resolution directly,
// since the tree only exercises the paths its content happens to link.
// ---------------------------------------------------------------------------

describe('contentPathsOfLink', () => {
  it("resolves a same-collection link in the reader's own line", () => {
    expect(contentPathsOfLink('/sdk/quickstart', 'sdk/v0.18/index.mdx')[0])
      .toBe('sdk/v0.18/quickstart')
  })

  it('resolves a link from the current line inside the group', () => {
    expect(contentPathsOfLink('/sdk/quickstart', 'sdk/(v0.19)/index.mdx')[0])
      .toBe('sdk/(v0.19)/quickstart')
  })

  it('resolves a link arriving from another collection in the current line', () => {
    expect(contentPathsOfLink('/sdk/quickstart', 'ecosystem/index.mdx')[0])
      .toBe('sdk/(v0.19)/quickstart')
  })

  it('leaves a link that names its version alone', () => {
    expect(contentPathsOfLink('/sdk/v0.18/quickstart', 'ecosystem/index.mdx'))
      .toEqual(['sdk/v0.18/quickstart'])
  })

  it('leaves a link to an unversioned collection alone', () => {
    expect(contentPathsOfLink('/ecosystem/addons', 'sdk/v0.18/index.mdx'))
      .toEqual(['ecosystem/addons'])
  })

  it('points a link at a page missing from the line, so the check fails', () => {
    const [inLine] = contentPathsOfLink('/sdk/nowhere', 'sdk/v0.18/index.mdx')
    expect(inLine).toBe('sdk/v0.18/nowhere')
    expect(fs.existsSync(path.join(DOCS_BASE, `${inLine}.mdx`))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration test: validate every internal link in the docs tree.
// ---------------------------------------------------------------------------

describe('docs link integrity', () => {
  it('has no broken internal links', async () => {
    const broken = await validateLinks(DOCS_BASE, DOCS_BASE)
    if (broken.length > 0) {
      const details = broken
        .map((b) => `  ${b.source} → ${b.target}`)
        .join('\n')
      expect.fail(`Found ${broken.length} broken link(s):\n${details}`)
    }
  })

  // The tree-wide check accepts a link that resolves at the collection's
  // literal path, for a collection not yet cut into lines. The SDK has been
  // cut, so its links get the stricter reading: each one must exist inside
  // the line of the page carrying it, with no fallback.
  it('resolves every SDK link inside its own line', () => {
    const lines = (getDocumentedSoftware('/sdk')?.versions ?? []).map(
      (version) => version.folder,
    )
    const offenders: string[] = []

    for (const line of lines) {
      const root = path.join(DOCS_BASE, 'sdk', line)
      for (const file of walk(root)) {
        const source = path.relative(DOCS_BASE, file).replaceAll('\\', '/')
        const links = extractInternalLinks(fs.readFileSync(file, 'utf-8'))

        for (const link of links.filter((l) => l.startsWith('/sdk'))) {
          const [inLine] = contentPathsOfLink(link, source)
          const lineRoot = `sdk/${line}`
          if (inLine !== lineRoot && !inLine.startsWith(`${lineRoot}/`)) {
            offenders.push(`${source} → ${link} left the line`)
            continue
          }
          const found = ['.mdx', '.md', '/index.mdx', '/index.md'].some((end) =>
            fs.existsSync(path.join(DOCS_BASE, inLine + end)),
          )
          if (!found) offenders.push(`${source} → ${link} (${inLine})`)
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })
})

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.mdx?$/.test(entry.name) ? [full] : []
  })
}

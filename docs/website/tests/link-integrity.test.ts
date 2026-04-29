import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateLinks, extractInternalLinks } from '../scripts/lib/link-validator'

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
    expect(extractInternalLinks('see [Errors](/sdk/api/errors) for details'))
      .toEqual(['/sdk/api/errors'])
  })

  it('strips hash fragments', () => {
    expect(extractInternalLinks('see [type](/sdk/api/completion#completionparams)'))
      .toEqual(['/sdk/api/completion'])
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
// Integration test: validate every internal link in the docs tree.
//
// All non-API content lives at bare paths now (no `(latest)/` parens
// folder), so link validation walks the entire `content/docs/` tree.
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
})

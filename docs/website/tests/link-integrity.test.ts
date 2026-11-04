import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  validateLinks,
  validateDevelopmentLine,
  extractInternalLinks,
  contentPathsOfLink,
} from '../scripts/lib/link-validator'
import {
  DOCUMENTED_SOFTWARE,
  getCurrentLine,
  getDocumentedSoftware,
  isCurrentLineFolder,
} from '../src/lib/versions'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEBSITE_DIR = path.resolve(TESTS_DIR, '..')
const DOCS_BASE = path.join(WEBSITE_DIR, 'content', 'docs')

// Read from the manifest rather than written out: a cut moves the group and a
// retirement drops the oldest lines, so a test naming either would fail on the
// move rather than on the behaviour it covers.
const SDK_GROUP = getCurrentLine(getDocumentedSoftware('/sdk')!)!.folder
const SDK_LINE = getDocumentedSoftware('/sdk')!.versions.find(
  (entry) => !isCurrentLineFolder(entry.folder),
)!.folder

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

  it('ignores links inside an MDX comment', () => {
    const content = [
      '[live](/sdk/quickstart)',
      '{/* <Card href="/sdk/kotlin-sdk" /> and [parked](/sdk/kotlin-sdk) */}',
    ].join('\n')
    expect(extractInternalLinks(content)).toEqual(['/sdk/quickstart'])
  })

  it('ignores links inside a multi-line MDX comment', () => {
    const content = [
      '{/*',
      '  Waiting on a release.',
      '  <Card href="/sdk/kotlin-sdk" title="Kotlin SDK" />',
      '*/}',
      '[live](/sdk/quickstart)',
    ].join('\n')
    expect(extractInternalLinks(content)).toEqual(['/sdk/quickstart'])
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
    expect(contentPathsOfLink('/sdk/quickstart', `sdk/${SDK_LINE}/index.mdx`)[0])
      .toBe(`sdk/${SDK_LINE}/quickstart`)
  })

  it('resolves a link from the current line inside the group', () => {
    expect(contentPathsOfLink('/sdk/quickstart', `sdk/${SDK_GROUP}/index.mdx`)[0])
      .toBe(`sdk/${SDK_GROUP}/quickstart`)
  })

  it('resolves a link arriving from another collection in the current line', () => {
    expect(contentPathsOfLink('/sdk/quickstart', 'ecosystem/index.mdx')[0])
      .toBe(`sdk/${SDK_GROUP}/quickstart`)
  })

  it('leaves a link that names its version alone', () => {
    expect(contentPathsOfLink(`/sdk/${SDK_LINE}/quickstart`, 'ecosystem/index.mdx'))
      .toEqual([`sdk/${SDK_LINE}/quickstart`])
  })

  it('leaves a link to an unversioned collection alone', () => {
    expect(contentPathsOfLink('/ecosystem/addons', `sdk/${SDK_LINE}/index.mdx`))
      .toEqual(['ecosystem/addons'])
  })

  it('points a link at a page missing from the line, so the check fails', () => {
    const [inLine] = contentPathsOfLink('/sdk/nowhere', `sdk/${SDK_LINE}/index.mdx`)
    expect(inLine).toBe(`sdk/${SDK_LINE}/nowhere`)
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

// ---------------------------------------------------------------------------
// The development line of each collection: the tree the build never sees.
//
// It sits outside `content/docs/`, so no page of it is rendered and no link in
// it is followed until the cutoff copies it into the collection — on the one
// PR of the release that cannot wait. These checks are what report a break on
// the PR that wrote it instead.
// ---------------------------------------------------------------------------

describe('the development line, which the build does not see', () => {
  const collections = DOCUMENTED_SOFTWARE.filter(
    (software) => software.kind === 'collection',
  ).map((software) => software.path.slice(1))

  describe.each(collections)('%s', (slug) => {
    const lineDir = path.join(
      WEBSITE_DIR,
      'content',
      '_unpublished',
      slug,
      'next',
    )
    it('has no broken internal links', async () => {
      const broken = await validateDevelopmentLine(slug, lineDir, DOCS_BASE)
      const details = broken.map((b) => `  ${b.source} → ${b.target}`).join('\n')
      expect(broken, `Found ${broken.length} broken link(s):\n${details}`)
        .toEqual([])
    })

    it('carries a title on every page, which Fumadocs requires', () => {
      const untitled = walk(lineDir).filter(
        (file) => titleOf(fs.readFileSync(file, 'utf-8')) === null,
      )
      expect(untitled.map((file) => path.relative(lineDir, file))).toEqual([])
    })
  })

  // The real lines carry no break, so what the check actually rejects is
  // pinned against a tree built here.
  describe('against a line written to fail', () => {
    let lineDir: string

    beforeAll(() => {
      lineDir = fs.mkdtempSync(path.join(tmpdir(), 'development-line-'))
      write(lineDir, 'index.mdx', [
        '---',
        'title: Introduction',
        '---',
        '',
        '[written this sprint](/sdk/models/fit)',
        '[never written](/sdk/nowhere)',
        '[another collection](/ecosystem/addons)',
        `[a line already cut](/sdk/${SDK_LINE}/index)`,
        `[a line already cut, missing the page](/sdk/${SDK_LINE}/nowhere)`,
      ].join('\n'))
      write(lineDir, path.join('models', 'fit.mdx'), '---\ntitle: Fit\n---\n')
      write(lineDir, 'untitled.mdx', 'No frontmatter at all.\n')
    })

    afterAll(() => {
      fs.rmSync(lineDir, { recursive: true, force: true })
    })

    it('accepts a link to a page the same sprint wrote', async () => {
      const broken = await validateDevelopmentLine('sdk', lineDir, DOCS_BASE)
      expect(broken.map((b) => b.target)).not.toContain('/sdk/models/fit')
    })

    it('reports a link to a page nothing wrote', async () => {
      const broken = await validateDevelopmentLine('sdk', lineDir, DOCS_BASE)
      expect(broken.map((b) => b.target)).toContain('/sdk/nowhere')
    })

    it('accepts a link into another collection, resolved as a published page', async () => {
      const broken = await validateDevelopmentLine('sdk', lineDir, DOCS_BASE)
      expect(broken.map((b) => b.target)).not.toContain('/ecosystem/addons')
    })

    it('reads a link that names a version against the line it names', async () => {
      const broken = await validateDevelopmentLine('sdk', lineDir, DOCS_BASE)
      expect(broken.map((b) => b.target)).not.toContain(`/sdk/${SDK_LINE}/index`)
      expect(broken.map((b) => b.target)).toContain(`/sdk/${SDK_LINE}/nowhere`)
    })

    it('reports a page carrying no title', () => {
      const untitled = walk(lineDir).filter(
        (file) => titleOf(fs.readFileSync(file, 'utf-8')) === null,
      )
      expect(untitled.map((file) => path.basename(file))).toEqual([
        'untitled.mdx',
      ])
    })
  })
})

/** The frontmatter `title` of a page, or `null` when it declares none. */
function titleOf(content: string): string | null {
  if (!content.startsWith('---\n')) return null
  const closing = content.indexOf('\n---', 4)
  if (closing < 0) return null
  const match = /^title:\s*(.+)$/m.exec(content.slice(0, closing))
  return match ? match[1].trim() : null
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.mdx?$/.test(entry.name) ? [full] : []
  })
}

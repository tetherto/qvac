/**
 * Unit tests for the `release-notes-patch-section.njk` template, which
 * is rendered by `generate-release-notes.ts --append-patch` to add a new
 * section to the bottom of an existing release-notes page.
 *
 * We test the template directly rather than spawning the script so the
 * test stays fast and isolated. The fixtures cover:
 *   - The section is rendered as `## v<X.Y.Z>` (not as frontmatter).
 *   - The NPM badge for the patch version is included.
 *   - Per-package category entries render as `### <Category>` then
 *     `#### @qvac/<pkg>` (one h-level deeper than the minor's page).
 *   - Overrides render between the preambles and the categories.
 *   - Empty categories / preambles / overrides degrade gracefully.
 *
 * We also exercise the append behaviour itself (existing body + newline
 * + section) via a thin helper that mirrors the script's append step,
 * so regressions in either side surface in a focused test.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import nunjucks from 'nunjucks'

const SCRIPT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'api-docs',
)
const TEMPLATE_DIR = path.join(SCRIPT_DIR, 'templates')

function createEnv(): nunjucks.Environment {
  return new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATE_DIR), {
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  })
}

interface RenderContext {
  version: string
  categories: Array<{
    name: string
    packages: Array<{ pkg: string; content: string }>
  }>
  preambles: Array<{ pkg: string; content: string }>
  overrides: Array<{ heading: string; content: string }>
  hasPreambleNpmLink: boolean
}

function render(ctx: Partial<RenderContext>): string {
  return createEnv().render('release-notes-patch-section.njk', {
    version: '0.0.0',
    categories: [],
    preambles: [],
    overrides: [],
    hasPreambleNpmLink: false,
    ...ctx,
  })
}

describe('release-notes-patch-section.njk', () => {
  it('renders the version heading as `## v<X.Y.Z>` (no frontmatter)', () => {
    const out = render({ version: '0.10.3' })
    expect(out).toContain('## v0.10.3')
    expect(out).not.toMatch(/^---/m)
    expect(out).not.toContain('title:')
  })

  it('includes the NPM badge for the patch version when no preamble carries one', () => {
    const out = render({ version: '0.10.3' })
    expect(out).toContain('https://www.npmjs.com/package/@qvac/sdk/v/0.10.3')
  })

  it('suppresses the NPM badge when the preamble already includes one', () => {
    // hasPreambleNpmLink is computed by generate-release-notes.ts from the
    // preamble content. When true, the template must NOT emit a second
    // badge line — otherwise we double up the NPM link in the appended
    // section.
    const out = render({
      version: '0.10.3',
      hasPreambleNpmLink: true,
      preambles: [
        {
          pkg: 'sdk',
          content: '📦 **NPM:** https://www.npmjs.com/package/@qvac/sdk/v/0.10.3\n\nBody.',
        },
      ],
    })
    const npmLinks = out.match(/https:\/\/www\.npmjs\.com\/package\/@qvac\/sdk\/v\/0\.10\.3/g) ?? []
    expect(npmLinks).toHaveLength(1)
  })

  it('renders categories as `### <Category>` with per-package `#### @qvac/<pkg>` entries', () => {
    const out = render({
      version: '0.10.3',
      categories: [
        {
          name: 'Bug Fixes',
          packages: [
            { pkg: 'sdk', content: '- Fixed handle leak in `loadModel`.' },
            { pkg: 'cli', content: '- Fixed CLI exit code on `--help`.' },
          ],
        },
      ],
    })
    expect(out).toMatch(/^### Bug Fixes/m)
    expect(out).toMatch(/^#### @qvac\/sdk/m)
    expect(out).toMatch(/^#### @qvac\/cli/m)
    expect(out).toContain('Fixed handle leak in `loadModel`.')
    expect(out).toContain('Fixed CLI exit code on `--help`.')
  })

  it('renders preambles before categories', () => {
    const out = render({
      version: '0.10.3',
      preambles: [{ pkg: 'sdk', content: 'Hotfix release for delegated inference.' }],
      categories: [
        {
          name: 'Bug Fixes',
          packages: [{ pkg: 'sdk', content: '- A fix.' }],
        },
      ],
    })
    const preambleIdx = out.indexOf('Hotfix release for delegated inference.')
    const categoryIdx = out.indexOf('### Bug Fixes')
    expect(preambleIdx).toBeGreaterThan(-1)
    expect(categoryIdx).toBeGreaterThan(-1)
    expect(preambleIdx).toBeLessThan(categoryIdx)
  })

  it('renders overrides between preambles and categories as `### <Heading>`', () => {
    const out = render({
      version: '0.10.3',
      preambles: [{ pkg: 'sdk', content: 'Preamble line.' }],
      overrides: [{ heading: 'Migration', content: 'Migration instructions.' }],
      categories: [
        {
          name: 'Bug Fixes',
          packages: [{ pkg: 'sdk', content: '- A fix.' }],
        },
      ],
    })
    const preambleIdx = out.indexOf('Preamble line.')
    const overrideHeadingIdx = out.indexOf('### Migration')
    const categoryIdx = out.indexOf('### Bug Fixes')
    expect(preambleIdx).toBeLessThan(overrideHeadingIdx)
    expect(overrideHeadingIdx).toBeLessThan(categoryIdx)
    expect(out).toContain('Migration instructions.')
  })

  it('renders cleanly with no categories / preambles / overrides', () => {
    const out = render({ version: '0.0.1' })
    // Still emits the heading + NPM line.
    expect(out).toContain('## v0.0.1')
    expect(out).toContain('https://www.npmjs.com/package/@qvac/sdk/v/0.0.1')
  })
})

// ---------------------------------------------------------------------------
// Append behaviour — mirrors the script's "trim trailing whitespace then
// concat section" step so we lock in the contract: the existing page body
// is preserved verbatim and the new section appears once at the bottom.
// ---------------------------------------------------------------------------

describe('append-patch concat semantics', () => {
  function appendSection(existing: string, section: string): string {
    const trimmed = existing.replace(/\s+$/, '')
    return `${trimmed}\n\n${section.trim()}\n`
  }

  it('appends a new section after the existing body with a blank-line separator', () => {
    const existing = [
      '---',
      'title: Release Notes — v0.10.0',
      '---',
      '',
      'Body line 1.',
      'Body line 2.',
      '',
    ].join('\n')
    const section = render({
      version: '0.10.1',
      categories: [
        {
          name: 'Bug Fixes',
          packages: [{ pkg: 'sdk', content: '- One fix.' }],
        },
      ],
    })
    const combined = appendSection(existing, section)
    // The existing body is preserved entirely (and only once).
    expect(combined).toContain('Body line 1.')
    expect(combined).toContain('Body line 2.')
    expect(combined).toContain('title: Release Notes — v0.10.0')
    // Separator: existing body ends with single \n then \n\n before the new
    // section's `## v` heading.
    expect(combined).toMatch(/Body line 2\.\n\n## v0\.10\.1/)
    // The new section appears exactly once.
    const headings = combined.match(/^## v0\.10\.1$/gm) ?? []
    expect(headings).toHaveLength(1)
  })
})

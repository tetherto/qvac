/**
 * Unit tests for the patch-flow rendering and insertion semantics in
 * `release-notes-patch-section.njk` + `generate-release-notes.ts`.
 *
 * The new model is **series-based**: each minor line has one permanent
 * MDX page (`vX.Y.x.mdx` or `index.mdx` for the current latest) that
 * accumulates patch sections as `## vX.Y.Z` directly after the
 * `## vX.Y.0` minor block. Newest patch sits right below the minor;
 * older patches further down.
 *
 * What we test:
 *   - The patch template renders just `## v<X.Y.Z>` + per-package
 *     `### @qvac/<pkg>` blocks with verbatim bodies (no frontmatter,
 *     no NPM badge dedup, no cross-package category merging).
 *   - The insertion semantics enforced by `generate-release-notes.ts`
 *     (`findInsertionAfterMinor`, replace-in-place idempotency) — tested
 *     by mirroring the script's splice logic, so the contract is locked
 *     in independently of script wiring.
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

interface PackageEntry {
  pkg: string
  body: string
}

interface RenderContext {
  version: string
  packages: PackageEntry[]
}

function renderSection(ctx: Partial<RenderContext>): string {
  return createEnv().render('release-notes-patch-section.njk', {
    version: '0.0.0',
    packages: [],
    ...ctx,
  })
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

describe('release-notes-patch-section.njk', () => {
  it('renders the version heading as `## v<X.Y.Z>` with no frontmatter', () => {
    const out = renderSection({ version: '0.10.3' })
    expect(out).toContain('## v0.10.3')
    expect(out).not.toMatch(/^---/m)
    expect(out).not.toContain('title:')
  })

  it('renders per-package subsections as `### @qvac/<pkg>` with verbatim bodies', () => {
    const out = renderSection({
      version: '0.10.3',
      packages: [
        { pkg: 'sdk', body: '#### Bug Fixes\n\n##### Fix one\n\nDescription.' },
        { pkg: 'cli', body: '#### Bug Fixes\n\n##### Fix CLI\n\nCLI fix body.' },
      ],
    })
    expect(out).toMatch(/^### @qvac\/sdk/m)
    expect(out).toMatch(/^### @qvac\/cli/m)
    expect(out).toContain('#### Bug Fixes')
    expect(out).toContain('##### Fix one')
    expect(out).toContain('CLI fix body.')
  })

  it('preserves per-package order in the rendered output', () => {
    const out = renderSection({
      version: '0.10.3',
      packages: [
        { pkg: 'sdk', body: 'sdk body' },
        { pkg: 'cli', body: 'cli body' },
        { pkg: 'rag', body: 'rag body' },
      ],
    })
    const sdkIdx = out.indexOf('### @qvac/sdk')
    const cliIdx = out.indexOf('### @qvac/cli')
    const ragIdx = out.indexOf('### @qvac/rag')
    expect(sdkIdx).toBeGreaterThan(-1)
    expect(cliIdx).toBeGreaterThan(sdkIdx)
    expect(ragIdx).toBeGreaterThan(cliIdx)
  })

  it('renders cleanly with an empty packages list (just the version heading)', () => {
    const out = renderSection({ version: '0.0.1' })
    expect(out).toContain('## v0.0.1')
    expect(out).not.toContain('### @qvac/')
  })
})

// ---------------------------------------------------------------------------
// Insertion semantics — mirror the script's splice logic.
//
// The contract we're locking in:
//   1. The new `## vX.Y.Z` block goes IMMEDIATELY AFTER the existing
//      `## vX.Y.0` minor block. Newest patch sits directly below the
//      minor; older patches further down.
//   2. Re-running the same patch is idempotent — the existing section
//      is replaced in place (no duplicate headings).
// ---------------------------------------------------------------------------

interface InsertionResult {
  offset: number
  minorIndex: number
}

function findInsertionAfterMinor(
  content: string,
  series: string,
): InsertionResult | null {
  const match = /^v(\d+)\.(\d+)\.x$/.exec(series)
  if (!match) return null
  const [, major, minor] = match
  const minorHeading = `## v${major}.${minor}.0`
  const lines = content.split('\n')
  let minorLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === minorHeading) {
      minorLineIdx = i
      break
    }
  }
  if (minorLineIdx < 0) return null
  let nextIdx = lines.length
  const versionHeadingRe = /^##\s+v\d+\.\d+\.\d+\b/
  for (let i = minorLineIdx + 1; i < lines.length; i++) {
    if (versionHeadingRe.test(lines[i])) {
      nextIdx = i
      break
    }
  }
  return { offset: lines.slice(0, nextIdx).join('\n').length, minorIndex: minorLineIdx }
}

function findExistingPatchBlock(
  content: string,
  version: string,
): { startOffset: number; endOffset: number } | null {
  const patchHeading = `## v${version}`
  const idx = content.indexOf(patchHeading)
  if (idx < 0) return null
  if (idx > 0 && content[idx - 1] !== '\n') return null
  const trailing = content.charCodeAt(idx + patchHeading.length)
  if (
    !Number.isNaN(trailing) &&
    trailing !== 0x0a &&
    trailing !== 0x20
  ) {
    return null
  }
  const nextRe = /\n##\s+v\d+\.\d+\.\d+\b/g
  nextRe.lastIndex = idx + patchHeading.length
  const nextMatch = nextRe.exec(content)
  const endOffset = nextMatch ? nextMatch.index + 1 : content.length
  return { startOffset: idx, endOffset }
}

function insertAfterMinor(existing: string, series: string, section: string): string {
  const replaceRange = findExistingPatchBlock(existing, section.match(/^## v(\d+\.\d+\.\d+)/)![1])
  if (replaceRange) {
    const before = existing.slice(0, replaceRange.startOffset).replace(/\s+$/, '')
    const after = existing.slice(replaceRange.endOffset).replace(/^\s+/, '')
    const middle = section.trim()
    return (
      (before ? before + '\n\n' : '') +
      middle +
      (after ? '\n\n' + after : '') +
      '\n'
    )
  }
  const insertion = findInsertionAfterMinor(existing, series)
  if (!insertion) throw new Error(`no minor block for ${series}`)
  const before = existing.slice(0, insertion.offset).replace(/\s+$/, '')
  const after = existing.slice(insertion.offset).replace(/^\s+/, '')
  const middle = section.trim()
  return before + '\n\n' + middle + (after ? '\n\n' + after : '') + '\n'
}

describe('insertion semantics — after the minor block', () => {
  it('inserts the patch section directly under the minor when no patches exist yet', () => {
    const existing = [
      '---',
      'title: SDK Release Notes — v0.11.x (latest)',
      'description: Release notes for QVAC SDK v0.11.0.',
      '---',
      '',
      '## v0.11.0',
      '',
      '### @qvac/sdk',
      '',
      'Minor body line 1.',
      '',
    ].join('\n')

    const section = renderSection({
      version: '0.11.1',
      packages: [{ pkg: 'sdk', body: 'Hotfix body.' }],
    })
    const combined = insertAfterMinor(existing, 'v0.11.x', section)

    expect(combined).toContain('## v0.11.0')
    expect(combined).toContain('## v0.11.1')
    const minorIdx = combined.indexOf('## v0.11.0')
    const patchIdx = combined.indexOf('## v0.11.1')
    expect(patchIdx).toBeGreaterThan(minorIdx)
    // The minor body is preserved.
    expect(combined).toContain('Minor body line 1.')
  })

  it('inserts the newest patch ABOVE older patches (newest-first below minor)', () => {
    const existing = [
      '---',
      'title: SDK Release Notes — v0.11.x (latest)',
      'description: Release notes for QVAC SDK v0.11.0.',
      '---',
      '',
      '## v0.11.0',
      '',
      '### @qvac/sdk',
      '',
      'Minor body.',
      '',
      '## v0.11.1',
      '',
      '### @qvac/sdk',
      '',
      'First patch body.',
      '',
    ].join('\n')

    const section = renderSection({
      version: '0.11.2',
      packages: [{ pkg: 'sdk', body: 'Second patch body.' }],
    })
    const combined = insertAfterMinor(existing, 'v0.11.x', section)

    const minorIdx = combined.indexOf('## v0.11.0')
    const patch2Idx = combined.indexOf('## v0.11.2')
    const patch1Idx = combined.indexOf('## v0.11.1')
    expect(minorIdx).toBeLessThan(patch2Idx)
    expect(patch2Idx).toBeLessThan(patch1Idx)
    // Both prior bodies are preserved.
    expect(combined).toContain('First patch body.')
    expect(combined).toContain('Second patch body.')
  })

  it('replaces the existing patch block in place on idempotent re-run (no duplicates)', () => {
    const existing = [
      '---',
      'title: SDK Release Notes — v0.11.x (latest)',
      '---',
      '',
      '## v0.11.0',
      '',
      '### @qvac/sdk',
      '',
      'Minor body.',
      '',
      '## v0.11.1',
      '',
      '### @qvac/sdk',
      '',
      'Old patch body.',
      '',
    ].join('\n')

    const section = renderSection({
      version: '0.11.1',
      packages: [{ pkg: 'sdk', body: 'Updated patch body.' }],
    })
    const combined = insertAfterMinor(existing, 'v0.11.x', section)

    const occurrences = combined.match(/^## v0\.11\.1\b/gm) ?? []
    expect(occurrences).toHaveLength(1)
    expect(combined).toContain('Updated patch body.')
    expect(combined).not.toContain('Old patch body.')
  })

  it('patch-archived: inserts into an archived series page directly under the minor', () => {
    const existing = [
      '---',
      'title: SDK Release Notes — v0.9.x',
      'description: Release notes for QVAC SDK v0.9.0.',
      '---',
      '',
      '## v0.9.0',
      '',
      '### @qvac/sdk',
      '',
      'Archived minor body.',
      '',
      '## v0.9.1',
      '',
      '### @qvac/sdk',
      '',
      'Prior patch body.',
      '',
    ].join('\n')

    const section = renderSection({
      version: '0.9.2',
      packages: [{ pkg: 'sdk', body: 'New archived patch body.' }],
    })
    const combined = insertAfterMinor(existing, 'v0.9.x', section)

    const minorIdx = combined.indexOf('## v0.9.0')
    const patch2Idx = combined.indexOf('## v0.9.2')
    const patch1Idx = combined.indexOf('## v0.9.1')
    expect(minorIdx).toBeLessThan(patch2Idx)
    expect(patch2Idx).toBeLessThan(patch1Idx)
    expect(combined).toContain('New archived patch body.')
    expect(combined).toContain('Archived minor body.')
    expect(combined).toContain('Prior patch body.')
  })
})

/**
 * Regression test for the hard-coded TypeScript template inside
 * `scripts/update-versions-list.ts`.
 *
 * Background: the generator script overwrites `src/lib/versions.ts` from a
 * template literal every time it runs. If a contributor adds a new export to
 * `versions.ts` (consumed by the website) but forgets to mirror it into the
 * generator template, the first invocation of `bun run docs:update-versions`
 * silently strips that export and the Next.js build breaks with
 * "Export <name> doesn't exist in target module".
 *
 * This test guards against that footgun by asserting every public symbol
 * declared in `src/lib/versions.ts` also appears as an exported declaration
 * inside the generator source (which carries the template).
 *
 * Note: we match the generator source as a plain string rather than executing
 * the template, because the template is a TypeScript literal and re-emitting
 * it would only re-encode the same source we already have on disk.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const websiteRoot = path.resolve(__dirname, '..')
const generatorPath = path.join(
  websiteRoot,
  'scripts',
  'update-versions-list.ts',
)
const versionsTsPath = path.join(websiteRoot, 'src', 'lib', 'versions.ts')

interface ExportedSymbol {
  kind: 'interface' | 'function' | 'const'
  name: string
}

/**
 * Parse `export interface|function|const Name` declarations out of a TS file.
 * Comments / strings inside template literals also match — that's intentional:
 * the generator template lives inside a literal and we want to assert both
 * the produced file and the source-of-truth template declare the symbol.
 */
function findExportedSymbols(source: string): ExportedSymbol[] {
  const re = /export\s+(interface|function|const)\s+([A-Z_][A-Za-z0-9_]*)/g
  const out: ExportedSymbol[] = []
  for (const m of source.matchAll(re)) {
    out.push({ kind: m[1] as ExportedSymbol['kind'], name: m[2] })
  }
  return out
}

describe('update-versions-list.ts template parity', () => {
  it('emits every export declared in src/lib/versions.ts', () => {
    const versionsSource = readFileSync(versionsTsPath, 'utf-8')
    const generatorSource = readFileSync(generatorPath, 'utf-8')

    const versionsExports = findExportedSymbols(versionsSource)
    expect(versionsExports.length, 'versions.ts should export something').toBeGreaterThan(0)

    const generatorMentions = new Set(
      findExportedSymbols(generatorSource).map((e) => `${e.kind}:${e.name}`),
    )

    const missing = versionsExports
      .map((e) => ({ ...e, key: `${e.kind}:${e.name}` }))
      .filter((e) => !generatorMentions.has(e.key))
      .map((e) => `${e.kind} ${e.name}`)

    expect(
      missing,
      `update-versions-list.ts template is missing exports that exist in src/lib/versions.ts. ` +
        `If you added a new export to versions.ts, mirror it into the template inside the ` +
        `generator script (otherwise running \`bun run docs:update-versions\` will strip it ` +
        `and break the Next.js build).`,
    ).toEqual([])
  })

  it('mirrors the helper functions consumed by the website (sanity check)', () => {
    /**
     * Hard-coded smoke list of symbols whose absence has historically broken
     * the build. Independent of the generic parity assertion above so a
     * future refactor that loosens the parser still flags these specifically.
     */
    const requiredSymbols = [
      'VersionEntry',
      'VersionedSection',
      'API_SECTION',
      'RELEASE_NOTES_SECTION',
      'LATEST_VERSION',
      'getVersionedSection',
      'getCurrentVersion',
      'computeSectionVersionUrl',
      'VersionSelectorProps',
      'getVersionSelectorProps',
    ]

    const generatorSource = readFileSync(generatorPath, 'utf-8')
    const missing = requiredSymbols.filter(
      (name) => !new RegExp(`export\\s+(interface|function|const)\\s+${name}\\b`).test(generatorSource),
    )

    expect(
      missing,
      `Missing required symbols in update-versions-list.ts template: ${missing.join(', ')}`,
    ).toEqual([])
  })
})

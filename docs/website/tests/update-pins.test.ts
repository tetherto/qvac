import { describe, expect, it } from 'vitest'
import { lineOf, packageDirOf, planPin, releasesVersion, type PinRequest } from '../scripts/update-pins'
import { parseVersionsFile, type VersionsFile } from '../src/lib/versions-file'

const declaration = (lines: unknown[]): VersionsFile =>
  parseVersionsFile('sdk.json', {
    package: '@qvac/sdk',
    kind: 'product',
    path: '/sdk',
    paths: ['packages/sdk/docs/users', 'packages/sdk/examples'],
    lines,
  })

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const request = (overrides: Partial<PinRequest> = {}): PinRequest => ({
  ref: 'release-sdk-0.24.0',
  sha: SHA_B,
  packageVersion: '0.24.0',
  releasesVersion: true,
  changedSince: () => true,
  ...overrides,
})

describe('pinning a release', () => {
  it('reads the line and the package directory', () => {
    expect(lineOf('0.24.1')).toBe('v0.24')
    expect(packageDirOf(declaration([{ version: 'v0.23', inPlace: true }]))).toBe('packages/sdk')
  })

  it('declares a new minor first, pinned to the release branch', () => {
    const { move, next } = planPin(declaration([{ version: 'v0.23', ref: 'release-sdk-0.23.2', sha: SHA_A }]), request())
    expect(move).toEqual({ kind: 'declare', version: 'v0.24' })
    expect(next.lines[0]).toEqual({ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_B })
    expect(next.lines).toHaveLength(2)
  })

  it('moves the pin of a patch release to the later branch, even with no documentation change', () => {
    const { move, next } = planPin(
      declaration([{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }]),
      request({ ref: 'release-sdk-0.24.1', packageVersion: '0.24.1', changedSince: () => false }),
    )
    expect(move).toMatchObject({ kind: 'move', from: { ref: 'release-sdk-0.24.0', sha: SHA_A } })
    expect(next.lines[0]).toEqual({ version: 'v0.24', ref: 'release-sdk-0.24.1', sha: SHA_B })
  })

  it('moves the pin to a documentation fix merged into the same branch', () => {
    const { move } = planPin(declaration([{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }]), request())
    expect(move.kind).toBe('move')
  })

  it('leaves the pin when nothing documented changed on the same branch', () => {
    const { move, next } = planPin(
      declaration([{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }]),
      request({ changedSince: () => false }),
    )
    expect(move).toMatchObject({ kind: 'unchanged', reason: 'no documented path changed' })
    expect(next.lines[0]).toMatchObject({ sha: SHA_A })
  })

  it('never moves a pin back to an earlier patch branch', () => {
    const { move } = planPin(
      declaration([{ version: 'v0.24', ref: 'release-sdk-0.24.2', sha: SHA_A }]),
      request({ ref: 'release-sdk-0.24.1', packageVersion: '0.24.1' }),
    )
    expect(move).toMatchObject({ kind: 'unchanged', reason: 'release-sdk-0.24.2 is a later patch branch' })
  })

  it('never moves the previous line onto a new branch cut before its bump', () => {
    // release-sdk-0.25.0 cut from a main still at 0.24.x: its version reads as v0.24.
    const { move, next } = planPin(
      declaration([{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }]),
      request({ ref: 'release-sdk-0.25.0', packageVersion: '0.24.0', releasesVersion: false }),
    )
    expect(move).toEqual({ kind: 'unchanged', version: 'v0.24', reason: 'not the version this branch releases yet' })
    expect(next.lines).toEqual([{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }])
  })

  it('declares the line of a main bumped before the cut', () => {
    const { move } = planPin(
      declaration([{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }]),
      request({ ref: 'release-sdk-0.25.0', packageVersion: '0.25.0', releasesVersion: false }),
    )
    expect(move).toEqual({ kind: 'declare', version: 'v0.25' })
  })

  it('still moves the pin to a documentation fix on a branch whose version was never bumped from main', () => {
    const { move } = planPin(
      declaration([{ version: 'v0.25', ref: 'release-sdk-0.25.0', sha: SHA_A }]),
      request({ ref: 'release-sdk-0.25.0', packageVersion: '0.25.0', releasesVersion: false }),
    )
    expect(move.kind).toBe('move')
  })

  it('moves the pin to a patch branch cut from a main that already holds its version', () => {
    const { move } = planPin(
      declaration([{ version: 'v0.25', ref: 'release-sdk-0.25.0', sha: SHA_A }]),
      request({ ref: 'release-sdk-0.25.1', packageVersion: '0.25.1', releasesVersion: true }),
    )
    expect(move).toMatchObject({ kind: 'move', version: 'v0.25' })
  })

  it('pins nothing over a line still held in place', () => {
    const { move, next } = planPin(declaration([{ version: 'v0.24', inPlace: true }]), request())
    expect(move.kind).toBe('held-in-place')
    expect(next.lines).toEqual([{ version: 'v0.24', inPlace: true }])
  })

  it('declares an older minor in version order', () => {
    const { next } = planPin(
      declaration([
        { version: 'v0.25', ref: 'release-sdk-0.25.0', sha: SHA_A },
        { version: 'v0.23', ref: 'release-sdk-0.23.0', sha: SHA_A },
      ]),
      request(),
    )
    expect(next.lines.map((line) => line.version)).toEqual(['v0.25', 'v0.24', 'v0.23'])
  })
})

describe('previewing a release pull request', () => {
  it('overrides the pinned line of the released package with the checkout, and reports what it cannot preview', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { previewFlags } = await import('../scripts/release-preview-flags')
    const root = mkdtempSync(path.join(tmpdir(), 'preview-'))
    const write = (file: string, value: unknown) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), JSON.stringify(value))
    }
    const base = { kind: 'product', retired: [] }
    write('docs/website/versions/sdk.json', { ...base, package: '@qvac/sdk', path: '/sdk', paths: ['packages/sdk/docs/users'], lines: [{ version: 'v0.24', ref: 'release-sdk-0.24.0', sha: SHA_A }] })
    write('docs/website/versions/cli.json', { ...base, package: '@qvac/cli', path: '/cli', paths: ['packages/cli/docs/users'], lines: [{ version: 'v0.18', inPlace: true }] })
    write('pr/packages/sdk/package.json', { version: '0.24.1' })
    write('pr/packages/cli/package.json', { version: '0.19.0' })

    expect(previewFlags('pr', ['sdk'], root)).toEqual({ flags: ['--override sdk@v0.24=pr'], notes: [] })
    expect(previewFlags('pr', ['cli'], root)).toEqual({ flags: [], notes: ['@qvac/cli v0.19: not pinned on main yet, so it cannot be previewed'] })
  })
})

describe('the version a release branch releases', () => {
  it('is the one a package branch names, even when main held it before the cut', () => {
    expect(releasesVersion('release-sdk-0.25.1', 'packages/sdk', '0.25.1', '0.25.1')).toBe(true)
    expect(releasesVersion('release-sdk-0.26.0', 'packages/sdk', '0.25.0', '0.25.0')).toBe(false)
    expect(releasesVersion('release-sdk-0.26.0', 'packages/sdk', '0.26.0', '0.25.0')).toBe(true)
  })

  it('on a train branch, any version other than the one it was cut with', () => {
    expect(releasesVersion('release-train-sdk-0.26.0', 'packages/cli', '0.20.0', '0.19.2')).toBe(true)
    expect(releasesVersion('release-train-sdk-0.26.0', 'packages/cli', '0.19.2', '0.19.2')).toBe(false)
  })
})

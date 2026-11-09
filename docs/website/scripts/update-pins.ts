#!/usr/bin/env bun
/**
 * Publish documentation lines from a release branch by pinning them.
 *
 * Usage:
 *   bun run scripts/update-pins.ts --ref <release-branch> --sha <commit> --package <dir>... [--summary <file>]
 *
 * For each documented software whose package directory (`packages/<dir>`) is
 * named, reads the package's version at `<commit>` and edits its versions
 * file:
 *
 * - its minor has no line: the line is declared, pinned to `<ref>@<commit>`,
 *   in version order — first for a new minor;
 * - its line is pinned elsewhere: the pin moves to `<ref>@<commit>` when the
 *   ref is a later patch branch, or when any declared path changed between the
 *   two commits;
 * - its line is held in place: nothing is pinned, and the run says why.
 *
 * The packages are named rather than inferred, because a release branch holds
 * every package of the monorepo and releases only some of them. Writes nothing
 * when nothing moves. `--summary` writes a Markdown description of the moves,
 * the body of the pull request that carries them.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  compareLineVersions,
  isPinnedLine,
  parseVersionsFile,
  type VersionsFile,
  type VersionsLine,
} from '../src/lib/versions-file'

const WEBSITE = path.resolve(import.meta.dirname, '..')
const MONOREPO = path.resolve(WEBSITE, '..', '..')
const VERSIONS_DIR = path.join(WEBSITE, 'versions')

export interface PinRequest {
  ref: string
  sha: string
  /** The package's version at `sha`, `x.y.z`. */
  packageVersion: string
  /** Whether a declared path differs between `from` and `sha`. */
  changedSince: (from: string) => boolean
}

export type PinMove =
  | { kind: 'declare'; version: string }
  | { kind: 'move'; version: string; from: { ref: string; sha: string } }
  | { kind: 'unchanged'; version: string; reason: string }
  | { kind: 'held-in-place'; version: string }

/** The documentation root's package directory: `packages/sdk/docs/users` → `packages/sdk`. */
export function packageDirOf(declaration: VersionsFile): string {
  return path.posix.dirname(path.posix.dirname(declaration.paths[0]))
}

export function lineOf(packageVersion: string): string {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(packageVersion)
  if (!match) throw new Error(`'${packageVersion}' is not a release version`)
  return `v${match[1]}.${match[2]}`
}

/** The `x.y.z` a release branch name ends with, if any. */
function branchVersion(ref: string): number[] | null {
  const match = /-(\d+)\.(\d+)\.(\d+)$/.exec(ref)
  return match ? match.slice(1).map(Number) : null
}

function olderBranch(candidate: string, current: string): boolean {
  const a = branchVersion(candidate)
  const b = branchVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

/** What pinning a release does to one versions file, and the file that results. */
export function planPin(declaration: VersionsFile, request: PinRequest): { move: PinMove; next: VersionsFile } {
  const version = lineOf(request.packageVersion)
  const lines = declaration.lines
  const existing = lines.find((line) => line.version === version)
  const pinned: VersionsLine = { version, ref: request.ref, sha: request.sha }

  if (!existing) {
    const index = lines.findIndex((line) => compareLineVersions(line.version, version) < 0)
    const nextLines = [...lines]
    nextLines.splice(index === -1 ? lines.length : index, 0, pinned)
    return { move: { kind: 'declare', version }, next: { ...declaration, lines: nextLines } }
  }
  if (!isPinnedLine(existing)) return { move: { kind: 'held-in-place', version }, next: declaration }
  if (existing.ref === request.ref && existing.sha === request.sha) {
    return { move: { kind: 'unchanged', version, reason: 'already pinned to this commit' }, next: declaration }
  }
  if (olderBranch(request.ref, existing.ref)) {
    return { move: { kind: 'unchanged', version, reason: `${existing.ref} is a later patch branch` }, next: declaration }
  }
  if (existing.ref === request.ref && !request.changedSince(existing.sha)) {
    return { move: { kind: 'unchanged', version, reason: 'no documented path changed' }, next: declaration }
  }
  const nextLines = lines.map((line) => (line.version === version ? pinned : line))
  return {
    move: { kind: 'move', version, from: { ref: existing.ref, sha: existing.sha } },
    next: { ...declaration, lines: nextLines },
  }
}

function git(...args: string[]): string {
  return execFileSync('git', ['-C', MONOREPO, ...args], { encoding: 'utf-8' }).trim()
}

function readAt(sha: string, file: string): string | null {
  try {
    return execFileSync('git', ['-C', MONOREPO, 'show', `${sha}:${file}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function changedBetween(from: string, to: string, paths: readonly string[]): boolean {
  try {
    execFileSync('git', ['-C', MONOREPO, 'diff', '--quiet', from, to, '--', ...paths], { stdio: 'ignore' })
    return false
  } catch {
    return true
  }
}

function describe(declaration: VersionsFile, move: PinMove, ref: string, sha: string): string {
  const where = `\`${ref}\` @ \`${sha.slice(0, 12)}\``
  switch (move.kind) {
    case 'declare':
      return `- ${declaration.package} ${move.version}: declared, pinned to ${where}.`
    case 'move':
      return `- ${declaration.package} ${move.version}: pin moved from \`${move.from.ref}\` @ \`${move.from.sha.slice(0, 12)}\` to ${where}.`
    case 'unchanged':
      return `- ${declaration.package} ${move.version}: unchanged (${move.reason}).`
    case 'held-in-place':
      return `- ${declaration.package} ${move.version}: still held in place under \`content/docs/\`; pinning it also removes that folder, by hand.`
  }
}

function parseArgs(argv: string[]): { ref: string; sha: string; packages: string[]; summary: string | null } {
  let ref = ''
  let sha = ''
  let summary: string | null = null
  const packages: string[] = []
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--ref') ref = value
    else if (flag === '--sha') sha = value
    else if (flag === '--package') packages.push(value)
    else if (flag === '--summary') summary = value
    else throw new Error(`unknown argument '${flag}'`)
  }
  if (!ref || !sha || packages.length === 0) {
    throw new Error('usage: update-pins.ts --ref <branch> --sha <commit> --package <dir>... [--summary <file>]')
  }
  return { ref, sha: git('rev-parse', `${sha}^{commit}`), packages, summary }
}

if (import.meta.main) {
  const { ref, sha, packages, summary } = parseArgs(process.argv.slice(2))
  const report: string[] = []
  let moved = 0
  for (const file of readdirSync(VERSIONS_DIR).filter((name) => name.endsWith('.json')).sort()) {
    const full = path.join(VERSIONS_DIR, file)
    const raw = JSON.parse(readFileSync(full, 'utf-8')) as Record<string, unknown>
    const declaration = parseVersionsFile(file, raw)
    if (declaration.repo) continue
    const packageDir = packageDirOf(declaration)
    if (!packages.includes(path.posix.basename(packageDir))) continue
    const manifest = readAt(sha, `${packageDir}/package.json`)
    if (!manifest) {
      report.push(`- ${declaration.package}: no \`${packageDir}/package.json\` at this commit; nothing pinned.`)
      continue
    }
    if (readAt(sha, `${declaration.paths[0]}/meta.json`) === null) {
      report.push(`- ${declaration.package}: no documentation root at this commit; nothing pinned.`)
      continue
    }
    const { version: packageVersion } = JSON.parse(manifest) as { version: string }
    const { move, next } = planPin(declaration, {
      ref,
      sha,
      packageVersion,
      changedSince: (from) => changedBetween(from, sha, declaration.paths),
    })
    report.push(describe(declaration, move, ref, sha))
    if (move.kind === 'declare' || move.kind === 'move') {
      // Only `lines` changes; every other field keeps its place and spelling.
      writeFileSync(full, `${JSON.stringify({ ...raw, lines: next.lines }, null, 2)}\n`)
      moved++
    }
  }
  const body = [`Documentation lines published from \`${ref}\` @ \`${sha.slice(0, 12)}\`:`, '', ...report].join('\n')
  console.log(body)
  if (summary) writeFileSync(summary, `${body}\n`)
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `moved=${moved}\n`, { flag: 'a' })
}

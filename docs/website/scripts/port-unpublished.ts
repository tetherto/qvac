#!/usr/bin/env bun
/**
 * Port edits made to the former unpublished content onto the documentation
 * roots that replaced it.
 *
 * Usage (from docs/website):
 *   bun run scripts/port-unpublished.ts <from> [<to>]
 *
 * The development line of the SDK and the CLI used to live in
 * `docs/website/content/_unpublished/{sdk,cli}/next/`. It now lives in each
 * package's documentation root, `packages/{sdk,cli}/docs/users/`. A change
 * made to the old folder between `<from>` and `<to>` (default `HEAD`) is
 * applied to the new one with a three-way merge, so only a line both sides
 * edited conflicts, and links to the former single API page
 * (`/sdk/reference/api#<function>`) are pointed at each function's page.
 *
 * Use it after merging a branch that still edits the old folder: pass the
 * commit the branch last shared with this one.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

const MONOREPO = path.resolve(import.meta.dirname, '..', '..', '..')
const MOVES: ReadonlyArray<[string, string]> = [
  ['docs/website/content/_unpublished/sdk/next/', 'packages/sdk/docs/users/'],
  ['docs/website/content/_unpublished/cli/next/', 'packages/cli/docs/users/'],
]
const REFERENCE = path.join(MONOREPO, 'packages/sdk/docs/users/reference/api')

function git(args: string[], input?: string): string {
  return execFileSync('git', args, { cwd: MONOREPO, encoding: 'utf-8', input, maxBuffer: 256 * 1024 * 1024 })
}

/** The diff of the old folders, with every path rewritten to its new home. */
export function rewrittenDiff(diff: string): string {
  let out = diff
  for (const [from, to] of MOVES) out = out.split(from).join(to)
  return out
}

/** Links to the former single API page, pointed at each function's own page. */
export function pointApiLinks(text: string, functions: readonly string[]): { text: string; unknown: string[] } {
  const byAnchor = new Map(functions.map((name) => [name.toLowerCase(), name]))
  const unknown: string[] = []
  const result = text.replace(/\/sdk\/reference\/api#([A-Za-z0-9_-]+)/g, (link, anchor: string) => {
    const name = byAnchor.get(anchor.toLowerCase())
    if (name) return `/sdk/reference/api/${name}`
    unknown.push(anchor)
    return link
  })
  return { text: result, unknown }
}

function referenceFunctions(): string[] {
  return readdirSync(REFERENCE)
    .filter((file) => file.endsWith('.mdx') && file !== 'index.mdx')
    .map((file) => file.slice(0, -'.mdx'.length))
}

function main(): void {
  const [from, to = 'HEAD'] = process.argv.slice(2)
  if (!from) {
    console.error('usage: port-unpublished.ts <from> [<to>]')
    process.exit(2)
  }
  const diff = git(['diff', '--binary', '--full-index', from, to, '--', ...MOVES.map(([old]) => old)])
  if (!diff.trim()) {
    console.log(`No change to the former unpublished content between ${from} and ${to}.`)
    return
  }
  const touched = [...new Set([...rewrittenDiff(diff).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]))]
  let conflicts = false
  try {
    git(['apply', '--3way', '--whitespace=nowarn', '-'], rewrittenDiff(diff))
  } catch (error) {
    conflicts = true
    console.error(String((error as { stderr?: string }).stderr ?? error))
  }

  const functions = referenceFunctions()
  for (const file of touched) {
    const absolute = path.join(MONOREPO, file)
    if (!existsSync(absolute) || !file.endsWith('.mdx')) continue
    const { text, unknown } = pointApiLinks(readFileSync(absolute, 'utf-8'), functions)
    writeFileSync(absolute, text)
    for (const anchor of unknown) console.warn(`${file}: no reference page for /sdk/reference/api#${anchor}`)
  }
  console.log(`Ported ${touched.length} file(s) from ${from}..${to}, links pointed. Review the result with git diff.`)
  if (conflicts) {
    console.error('Some hunks conflict: resolve the files git status marks UU, then stage them.')
    process.exitCode = 1
  }
}

if (import.meta.main) main()

#!/usr/bin/env bun
/**
 * The materializer flags that preview a pull request into a release branch.
 *
 * Usage:
 *   bun run scripts/release-preview-flags.ts --checkout <dir> --package <dir>...
 *
 * `<dir>` after `--checkout` is the pull request's checkout, relative to the
 * monorepo root; the site that builds is this one, `main`'s. For each named
 * package that has a versions file, reads the package's version in the
 * checkout and, when `main` declares that version's line pinned, prints
 * `--override <software>@<line>=<checkout>`: the line renders from the pull
 * request instead of its pin. A line `main` does not pin yet (a release whose
 * pin is still to merge) or still holds in place cannot be previewed this
 * way, and is reported on stderr instead. Prints nothing when no line can be
 * previewed.
 */
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { isPinnedLine, parseVersionsFile } from '../src/lib/versions-file'
import { lineOf, packageDirOf } from './update-pins'

const WEBSITE = path.resolve(import.meta.dirname, '..')
const MONOREPO = path.resolve(WEBSITE, '..', '..')

export function previewFlags(checkout: string, packages: readonly string[], root = MONOREPO): { flags: string[]; notes: string[] } {
  const flags: string[] = []
  const notes: string[] = []
  const versionsDir = path.join(root, 'docs', 'website', 'versions')
  for (const file of readdirSync(versionsDir).filter((name) => name.endsWith('.json')).sort()) {
    const declaration = parseVersionsFile(file, JSON.parse(readFileSync(path.join(versionsDir, file), 'utf-8')))
    if (declaration.repo) continue
    const packageDir = packageDirOf(declaration)
    if (!packages.includes(path.posix.basename(packageDir))) continue
    let version: string
    try {
      version = (JSON.parse(readFileSync(path.join(root, checkout, packageDir, 'package.json'), 'utf-8')) as { version: string }).version
    } catch {
      notes.push(`${declaration.package}: no ${packageDir}/package.json in the checkout`)
      continue
    }
    const line = lineOf(version)
    const declared = declaration.lines.find((entry) => entry.version === line)
    const slug = declaration.path.slice(1)
    if (!declared) notes.push(`${declaration.package} ${line}: not pinned on main yet, so it cannot be previewed`)
    else if (!isPinnedLine(declared)) notes.push(`${declaration.package} ${line}: held in place, so it builds from main's content/docs/`)
    else flags.push(`--override ${slug}@${line}=${checkout}`)
  }
  return { flags, notes }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  let checkout = ''
  const packages: string[] = []
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--checkout') checkout = argv[i + 1]
    else if (argv[i] === '--package') packages.push(argv[i + 1])
    else {
      console.error(`unknown argument '${argv[i]}'`)
      process.exit(2)
    }
  }
  if (!checkout || packages.length === 0) {
    console.error('usage: release-preview-flags.ts --checkout <dir> --package <dir>...')
    process.exit(2)
  }
  const { flags, notes } = previewFlags(checkout, packages)
  for (const note of notes) console.error(note)
  console.log(flags.join(' '))
}

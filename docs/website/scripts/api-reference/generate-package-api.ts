#!/usr/bin/env bun
/**
 * Generate a package's API reference data, committed with its documentation.
 *
 * Usage (from docs/website):
 *   npm run docs:api -- <package-dir> [--entry <file>] [--check]
 *
 * `<package-dir>` is relative to the monorepo root, `packages/<name>`. The
 * entry is the package's public declarations: `--entry`, else its
 * `package.json` `types`, else `index.d.ts`. Writes `_generated/api.json`
 * into the package's documentation root: every public export, normalized
 * from TypeDoc by `package-api.ts`.
 *
 * The data is the package's surface for the binding check, not a page. The
 * API reference page, `api.mdx`, is written by hand and binds `surface`, so a
 * change to any export fails `docs:bindings` and names that page.
 *
 * TypeDoc reads the package's dependencies, so this runs where they are
 * installed and its output is committed. `--check` fails when the data is
 * stale; the site build never reads it.
 */
import { existsSync, readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { packageApi } from './package-api'

const MONOREPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')

function parseArgs(argv: string[]): { packageDir: string; entry: string | null; check: boolean } {
  const check = argv.includes('--check')
  const rest = argv.filter((arg) => arg !== '--check')
  const entryAt = rest.indexOf('--entry')
  const entry = entryAt === -1 ? null : rest[entryAt + 1]
  const positional = entryAt === -1 ? rest : rest.filter((_, index) => index !== entryAt && index !== entryAt + 1)
  if (positional.length !== 1 || (entryAt !== -1 && !entry)) {
    throw new Error('usage: generate-package-api.ts <package-dir> [--entry <file>] [--check]')
  }
  return { packageDir: positional[0], entry, check }
}

export async function generatePackageApi(packageDir: string, options: { entry?: string | null; check?: boolean } = {}): Promise<string[]> {
  const root = path.resolve(MONOREPO_ROOT, packageDir)
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { name: string; types?: string; typings?: string }
  const entry = options.entry ?? manifest.types ?? manifest.typings ?? 'index.d.ts'
  const tsconfig = path.join(root, 'tsconfig.json')
  const api = await packageApi(root, entry, manifest.name, existsSync(tsconfig) ? tsconfig : null)

  const docsRoot = path.join(root, 'docs', 'users')
  const outputs: Record<string, string> = {
    [path.join(docsRoot, '_generated', 'api.json')]: `${JSON.stringify(api, null, 2)}\n`,
  }
  const stale: string[] = []
  for (const [file, content] of Object.entries(outputs)) {
    if (options.check) {
      const current = await fs.readFile(file, 'utf-8').catch(() => null)
      if (current !== content) stale.push(path.relative(MONOREPO_ROOT, file))
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content)
    }
  }
  return stale
}

if (import.meta.main) {
  try {
    const { packageDir, entry, check } = parseArgs(process.argv.slice(2))
    const stale = await generatePackageApi(packageDir, { entry, check })
    if (stale.length > 0) {
      console.error(`stale API reference data — run \`npm run docs:api -- ${packageDir}\`:\n  ${stale.join('\n  ')}`)
      process.exit(1)
    }
    if (!check) console.log(`wrote the API reference of ${packageDir}`)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}

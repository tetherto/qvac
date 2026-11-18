#!/usr/bin/env bun
/**
 * Generate a command-line product's reference data, committed with its
 * documentation.
 *
 * Usage:
 *   bun run scripts/api-reference/generate-cli-data.ts <software> --entry <file> [--openapi <module>#<export>] [--check]
 *
 * `<software>` names a versions file (`cli` → `versions/cli.json`); the data is
 * written into that software's documentation root, under `_generated/`:
 *
 *   - `cli.json` — the command tree of a Commander CLI: every command, its
 *     arguments, and its options with their flags, defaults, choices, and the
 *     same descriptions `--help` prints;
 *   - `openapi.json` — when `--openapi` names a function that renders the
 *     product's OpenAPI document without starting a server.
 *
 * Paths are relative to the product's package. Running the product's code
 * needs its dependencies installed. `--check` fails when the committed data
 * is stale.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { declaredSoftware } from '../../src/lib/versions'

const WEBSITE_ROOT = path.resolve(import.meta.dirname, '..', '..')
const MONOREPO_ROOT = path.resolve(WEBSITE_ROOT, '..', '..')

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const software = args[0]
  const entry = argument(args, '--entry')
  const openapi = argument(args, '--openapi')
  const check = args.includes('--check')
  if (!software || !entry) {
    console.error('usage: generate-cli-data.ts <software> --entry <file> [--openapi <module>#<export>] [--check]')
    process.exit(2)
  }

  const declaration = declaredSoftware().find((item) => item.file === `${software}.json`)?.declaration
  if (!declaration) throw new Error(`versions/${software}.json does not exist`)
  const docsRoot = path.join(MONOREPO_ROOT, declaration.paths[0])
  const packageDir = path.resolve(docsRoot, '..', '..')

  const walker = spawnSync(
    'bun',
    ['run', path.join(import.meta.dirname, 'commander-walker.ts'), entry, ...(openapi ? [openapi] : [])],
    { cwd: packageDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (walker.status !== 0) {
    throw new Error(`reading ${software}'s CLI failed (are its dependencies installed?):\n${walker.stderr}`)
  }
  const result = JSON.parse(walker.stdout.trim().split('\n').at(-1)!) as { cli: unknown; openapi: unknown }

  const outputs: Record<string, string> = { 'cli.json': JSON.stringify(result.cli, null, 2) + '\n' }
  if (result.openapi) outputs['openapi.json'] = JSON.stringify(result.openapi, null, 2) + '\n'

  const generated = path.join(docsRoot, '_generated')
  const stale: string[] = []
  for (const [file, content] of Object.entries(outputs)) {
    const target = path.join(generated, file)
    if (check) {
      if ((await fs.readFile(target, 'utf-8').catch(() => null)) !== content) stale.push(path.relative(MONOREPO_ROOT, target))
    } else {
      await fs.mkdir(generated, { recursive: true })
      await fs.writeFile(target, content)
      console.log(`wrote ${path.relative(MONOREPO_ROOT, target)}`)
    }
  }
  if (stale.length > 0) {
    console.error(`stale generated CLI data — regenerate:\n  ${stale.join('\n  ')}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error(error.message)
    process.exit(1)
  })
}

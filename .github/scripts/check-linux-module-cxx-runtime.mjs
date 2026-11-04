#!/usr/bin/env node
/**
 * Fail if a Linux prebuild (.so module or .bare addon) NEEDs a shared C++
 * runtime or leaves C++ runtime symbols undefined. See
 * lib/linux-module-cxx-runtime.mjs for the rule.
 *
 * Usage:
 *   node .github/scripts/check-linux-module-cxx-runtime.mjs <dir>...
 *
 * Every .so and .bare under each <dir> is checked; finding none is an error.
 * NM and READELF override the tools, which default to llvm-nm and
 * llvm-readelf, then nm and readelf.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  cxxRuntimeViolations,
  formatViolations,
  parseNeeded,
  parseUndefined,
} from './lib/linux-module-cxx-runtime.mjs'

function pickTool(override, candidates) {
  if (override) return override
  for (const tool of candidates) {
    if (!spawnSync(tool, ['--version'], { stdio: 'ignore' }).error) return tool
  }
  throw new Error(`none of ${candidates.join(', ')} found on PATH`)
}

function run(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${tool} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function listBinaries(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(so|bare)$/.test(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort()
}

const dirs = process.argv.slice(2)
if (dirs.length === 0) {
  console.error('usage: check-linux-module-cxx-runtime.mjs <dir>...')
  process.exit(2)
}

const nm = pickTool(process.env.NM, ['llvm-nm', 'nm'])
const readelf = pickTool(process.env.READELF, ['llvm-readelf', 'readelf'])
const files = dirs.flatMap(listBinaries)
if (files.length === 0) {
  console.error(`::error::no .so or .bare files under ${dirs.join(', ')}`)
  process.exit(1)
}

const failures = []
for (const file of files) {
  const violations = cxxRuntimeViolations({
    needed: parseNeeded(run(readelf, ['-d', file])),
    undefinedSymbols: parseUndefined(run(nm, ['-D', '--undefined-only', '-P', file])),
  })
  if (violations.needed.length > 0 || violations.symbols.length > 0) {
    failures.push(formatViolations(file, violations))
  } else {
    console.log(`ok: ${file}`)
  }
}

if (failures.length > 0) {
  console.log(`::error::${failures.length} of ${files.length} Linux prebuilds depend on a shared C++ runtime`)
  console.log(failures.join('\n'))
  process.exit(1)
}
console.log(`${files.length} Linux prebuilds carry no C++ runtime dependency (${nm}, ${readelf})`)

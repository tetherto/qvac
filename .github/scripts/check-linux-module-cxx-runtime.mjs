#!/usr/bin/env node
/**
 * Fail if a Linux prebuild (.so module or .bare addon) NEEDs a shared C++
 * runtime or leaves C++ runtime symbols unresolved. See
 * lib/linux-module-cxx-runtime.mjs for the rule.
 *
 * Usage:
 *   node .github/scripts/check-linux-module-cxx-runtime.mjs <dir>...
 *
 * --fabric <binary> verifies versioned imports against a shared Fabric provider.
 * --fabric-host <linux-arch> resolves that provider from the installed Fabric package.
 * --xdna validates the XDNA module against the system XRT/libstdc++ ABI.
 * Every .so and .bare under each <dir> is checked; finding none is an error.
 * NM and READELF override the tools, which default to llvm-nm and
 * llvm-readelf, then nm and readelf.
 */
import { resolveFabricBinary } from './lib/resolve-fabric-binary.mjs'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  cxxRuntimeViolations,
  fabricRuntimeViolations,
  parseVersionedSymbols,
  xdnaRuntimeViolations,
  formatViolations,
  parseNeeded,
  parseUndefined
} from './lib/linux-module-cxx-runtime.mjs'

function pickTool(override, candidates) {
  if (override) return override
  for (const tool of candidates) {
    if (!spawnSync(tool, ['--version'], { stdio: 'ignore' }).error) return tool
  }
  throw new Error(`none of ${candidates.join(', ')} found on PATH`)
}

function run(tool, args) {
  const result = spawnSync(tool, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
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

// Opt in only for Fabric's XRT-linked module; all other modules retain the
// static-runtime rule. XDNA's required system ABI is validated separately.
const withXdna = process.argv.includes('--xdna')
const args = process.argv.slice(2)
const fabricIndex = args.indexOf('--fabric')
let fabricFile = fabricIndex < 0 ? null : args[fabricIndex + 1]
if (fabricIndex >= 0 && (!fabricFile || fabricFile.startsWith('--'))) {
  throw new Error('--fabric requires the provider binary path')
}
if (fabricIndex >= 0) args.splice(fabricIndex, 2)
const hostIndex = args.indexOf('--fabric-host')
if (hostIndex >= 0) {
  if (fabricFile) throw new Error('--fabric and --fabric-host are mutually exclusive')
  fabricFile = resolveFabricBinary(process.cwd(), args[hostIndex + 1])
  args.splice(hostIndex, 2)
}
const dirs = args.filter((arg) => arg !== '--xdna')
if (dirs.length === 0) {
  console.error('usage: check-linux-module-cxx-runtime.mjs [--fabric <binary> | --fabric-host <linux-arch>] <dir>...')
  process.exit(2)
}

const nm = pickTool(process.env.NM, ['llvm-nm', 'nm'])
const readelf = pickTool(process.env.READELF, ['llvm-readelf', 'readelf'])
const fabric = fabricFile ? readFabric(fabricFile) : null
const files = dirs.flatMap(listBinaries)
if (files.length === 0) {
  console.error(`::error::no .so or .bare files under ${dirs.join(', ')}`)
  process.exit(1)
}

if (withXdna && !files.some((file) => basename(file) === 'libqvac-ggml-xdna.so')) {
  console.error('::error::--xdna requires libqvac-ggml-xdna.so in the prebuilds')
  process.exit(1)
}

const failures = []
for (const file of files) {
  const check =
    withXdna && basename(file) === 'libqvac-ggml-xdna.so'
      ? xdnaRuntimeViolations
      : cxxRuntimeViolations
  const needed = parseNeeded(run(readelf, ['-d', file]))
  const undefinedOutput = run(nm, ['-D', '--undefined-only', '-P', file])
  const violations =
    fabric && file.endsWith('.bare')
      ? fabricRuntimeViolations({
          needed,
          undefinedSymbols: parseVersionedSymbols(undefinedOutput),
          definedSymbols: parseVersionedSymbols(run(nm, ['-D', '--defined-only', '-P', file])),
          fabric
        })
      : check({ needed, undefinedSymbols: parseUndefined(undefinedOutput) })
  if (violations.needed.length > 0 || violations.symbols.length > 0) {
    failures.push(formatViolations(file, violations))
  } else {
    console.log(`ok: ${file}`)
  }
}

if (failures.length > 0) {
  console.log(
    `::error::${failures.length} of ${files.length} Linux prebuilds fail C++ runtime ABI validation`
  )
  console.log(failures.join('\n'))
  process.exit(1)
}
console.log(`${files.length} Linux prebuilds pass C++ runtime ABI validation (${nm}, ${readelf})`)

function readFabric(file) {
  const dynamic = run(readelf, ['-d', file])
  const violations = cxxRuntimeViolations({
    needed: parseNeeded(dynamic),
    undefinedSymbols: parseUndefined(run(nm, ['-D', '--undefined-only', '-P', file]))
  })
  if (violations.needed.length || violations.symbols.length) {
    throw new Error(formatViolations(file, violations))
  }
  return {
    soname: dynamic.match(/\(SONAME\)[^\n[]*\[([^\]\n]+)\]/)?.[1],
    symbols: parseVersionedSymbols(run(nm, ['-D', '--defined-only', '-P', file]))
  }
}

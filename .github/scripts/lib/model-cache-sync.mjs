/**
 * Parse every `cache-models` call site and check that each seed writes a cache
 * identity some consumer actually asks for.
 *
 * Why this exists: the seeding scheme depends on 13 seed steps reproducing
 * their consumers' `cache-models` inputs exactly. The cache key is
 *
 *   models-<package>-<cache-version>[-<cache-key-suffix>]-<hashFiles(glob)>
 *
 * and the cache *version* is derived from the resolved `paths` plus
 * `enable-cross-os`. Change any of those on one side only and the seed keeps
 * writing a key nothing restores. Nothing goes red: the seed still saves, and
 * its verify job asserts that same stale key, so it stays green too. The only
 * previous guard was a hand-written comment naming the consumer step.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOWS = join(ROOT, '.github/workflows')
const CALL = /uses:\s*\.\/\.github\/actions\/cache-models\s*$/

// Inputs that determine the key or the cache version. `warm`, `seed-probe`,
// `force-refresh` and `assert-exists` deliberately do not: they change what the
// step does, never which entry it addresses.
export const KEY_INPUTS = [
  'package',
  'cache-version',
  'cache-key-suffix',
  'group',
  'paths',
  'hash-files-glob',
  'enable-cross-os',
]
const DEFAULTS = { 'cache-version': 'v1', 'cache-key-suffix': '', group: '', 'enable-cross-os': 'true' }

export const listWorkflows = () =>
  readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml')).sort()

const isSeed = (file) => file.startsWith('on-merge-model-cache-')

// `${{ inputs.x && 'a' || 'b' }}` -> ['a', 'b']; `${{ matrix.k }}` -> matrix lookup.
function expand(value, matrixRow) {
  const ternary = value.match(/^\$\{\{\s*inputs\.\w+\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/)
  if (ternary) return [ternary[1], ternary[2]]
  const mref = value.match(/^\$\{\{\s*matrix\.(\w+)\s*\}\}$/)
  if (mref) return matrixRow && mref[1] in matrixRow ? [matrixRow[mref[1]]] : ['<unresolved>']
  return [value]
}

// Only the shapes this repo actually uses: `key: [a, b, c]` and `include:` rows.
function parseMatrix(lines, jobStart, jobEnd) {
  const rows = []
  for (let i = jobStart; i < jobEnd; i++) {
    const inline = lines[i].match(/^\s{6,8}(\w+):\s*\[([^\]]+)\]\s*$/)
    if (inline && /^\s+matrix:/.test(lines[i - 1] ?? '')) {
      for (const v of inline[2].split(',')) rows.push({ [inline[1]]: v.trim() })
    }
    if (/^\s+include:\s*$/.test(lines[i])) {
      let row = null
      for (let j = i + 1; j < jobEnd; j++) {
        const start = lines[j].match(/^\s{8,}-\s+(\w+):\s*(.*)$/)
        const cont = lines[j].match(/^\s{10,}(\w+):\s*(.*)$/)
        if (start) {
          if (row) rows.push(row)
          row = { [start[1]]: start[2].trim().replace(/^["']|["']$/g, '') }
        } else if (cont && row) {
          row[cont[1]] = cont[2].trim().replace(/^["']|["']$/g, '')
        } else if (/^\s{0,6}\S/.test(lines[j])) break
      }
      if (row) rows.push(row)
    }
  }
  return rows.length ? rows : [null]
}

// `${{ env.WORKDIR }}` -> the workflow's `env:` value -> if that is
// `${{ inputs.workdir }}`, the input's `default:`. cpp-tests-vla and friends
// address the cached paths through this chain while the seeds spell them out,
// so without resolving it every such pair looks like a mismatch.
function resolveEnvRefs(value, lines) {
  return value.replace(/\$\{\{\s*env\.(\w+)\s*\}\}/g, (whole, name) => {
    const envLine = lines.find((l) => new RegExp(`^\\s{2,}${name}:\\s*\\S`).test(l))
    if (!envLine) return whole
    let v = envLine.slice(envLine.indexOf(':') + 1).trim()
    const inputRef = v.match(/^\$\{\{\s*inputs\.(\w+)\s*\}\}$/)
    if (!inputRef) return v
    const idx = lines.findIndex((l) => new RegExp(`^\\s{6}${inputRef[1]}:\\s*$`).test(l))
    if (idx === -1) return whole
    for (let k = idx + 1; k < Math.min(idx + 8, lines.length); k++) {
      const d = lines[k].match(/^\s{8}default:\s*(.*)$/)
      if (d) return d[1].trim().replace(/^["']|["']$/g, '')
      if (/^\s{6}\S/.test(lines[k])) break
    }
    return whole
  })
}

export function parseCallSites(file) {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
  const sites = []
  for (let i = 0; i < lines.length; i++) {
    if (!CALL.test(lines[i])) continue
    const inputs = {}
    for (let j = i + 1; j < Math.min(i + 24, lines.length); j++) {
      if (/^\s{0,8}-\s+name:/.test(lines[j]) || /^\s{0,6}\S/.test(lines[j])) break
      const m = lines[j].match(/^(\s{8,})([a-z-]+):\s*(.*)$/)
      if (!m) continue
      if (m[3] === '|' || m[3] === '>-') {
        // Block scalar: continuation lines are strictly MORE indented than the
        // key. Anything at the key's own indent is the next input, not content.
        const keyIndent = m[1].length
        const parts = []
        for (let k = j + 1; k < lines.length; k++) {
          const ind = lines[k].match(/^(\s*)\S/)
          if (!ind || ind[1].length <= keyIndent) break
          parts.push(lines[k].trim())
        }
        inputs[m[2]] = parts.join(' ')
      } else {
        inputs[m[2]] = m[3].trim().replace(/^["']|["']$/g, '')
      }
    }
    // enclosing job, for matrix expansion
    let jobStart = 0
    for (let j = i; j >= 0; j--) if (/^  [a-zA-Z0-9_-]+:\s*$/.test(lines[j])) { jobStart = j; break }
    let jobEnd = lines.length
    for (let j = jobStart + 1; j < lines.length; j++) if (/^  [a-zA-Z0-9_-]+:\s*$/.test(lines[j])) { jobEnd = j; break }
    for (const k of Object.keys(inputs)) inputs[k] = resolveEnvRefs(inputs[k], lines)
    sites.push({ file, line: i + 1, inputs, matrix: parseMatrix(lines, jobStart, jobEnd) })
  }
  return sites
}

const identity = (inputs, row) => {
  const combos = [{}]
  for (const k of KEY_INPUTS) {
    const raw = inputs[k] ?? DEFAULTS[k] ?? ''
    const values = expand(String(raw), row)
    const next = []
    for (const base of combos) for (const v of values) next.push({ ...base, [k]: v })
    combos.length = 0
    combos.push(...next)
  }
  return combos.map((c) => KEY_INPUTS.map((k) => `${k}=${c[k]}`).join('|'))
}

export function collect(files = listWorkflows()) {
  const seeds = [], consumers = []
  for (const f of files) {
    for (const site of parseCallSites(f)) {
      // a verify job addresses the same entry it asserts; it is not a consumer
      const isVerify = site.inputs['assert-exists'] === 'true'
      for (const row of site.matrix) {
        for (const id of identity(site.inputs, row)) {
          const rec = { ...site, id, row }
          if (isSeed(f)) { if (!isVerify) seeds.push(rec) } else consumers.push(rec)
        }
      }
    }
  }
  return { seeds, consumers }
}

/** Every seed identity must be asked for by at least one consumer call site. */
export function findOrphanedSeeds(files) {
  const { seeds, consumers } = collect(files)
  const wanted = new Set(consumers.map((c) => c.id))
  return seeds.filter((s) => !wanted.has(s.id))
}

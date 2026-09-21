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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
export const UNRESOLVED = '<unresolved>'
const DEFAULTS = { 'cache-version': 'v1', 'cache-key-suffix': '', group: '', 'enable-cross-os': 'true' }

export const listWorkflows = () =>
  readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml')).sort()

const isSeed = (file) => file.startsWith('on-merge-model-cache-')

// `${{ inputs.x && 'a' || 'b' }}` -> ['a', 'b']; `${{ matrix.k }}` -> matrix lookup.
function expand(value, matrixRow) {
  const ternary = value.match(/^\$\{\{\s*inputs\.\w+\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/)
  if (ternary) return [ternary[1], ternary[2]]
  const mref = value.match(/^\$\{\{\s*matrix\.(\w+)\s*\}\}$/)
  if (mref) return matrixRow && mref[1] in matrixRow ? [matrixRow[mref[1]]] : [UNRESOLVED]
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

/**
 * integration-test-nx.yml drives cache-models from `matrix.modelCache`, which
 * comes from each package's project.json. Those are real consumer identities:
 * without them the lint is blind to the surface #3903 is migrating CI onto,
 * and to any collision between an nx lane and its per-addon equivalent.
 */
export function nxConsumers() {
  const pkgRoot = join(ROOT, 'packages')
  const out = []
  if (!existsSync(pkgRoot)) return out
  for (const pkg of readdirSync(pkgRoot).sort()) {
    const file = join(pkgRoot, pkg, 'project.json')
    if (!existsSync(file)) continue
    let doc
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const blocks = []
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk)
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (k === 'modelCache' && Array.isArray(v)) blocks.push(...v.filter((e) => e && typeof e === 'object'))
          else walk(v)
        }
      }
    }
    walk(doc)
    for (const b of blocks) {
      out.push({
        file: `packages/${pkg}/project.json`,
        line: 0,
        inputs: {
          package: pkg,
          'cache-version': String(b.cacheVersion ?? 'v1'),
          'cache-key-suffix': String(b.cacheKeySuffix ?? ''),
          group: String(b.group ?? ''),
          paths: String(b.paths ?? ''),
          'hash-files-glob': String(b.hashFilesGlob ?? ''),
          'enable-cross-os': String(b.enableCrossOs ?? 'true'),
        },
        matrix: [null],
      })
    }
  }
  return out
}

export function collect(files = listWorkflows()) {
  const seeds = [], consumers = []
  const sites = files.map((f) => [f, parseCallSites(f)])
  // nx's per-package blocks are consumers even though they are not workflow YAML
  sites.push(['integration-test-nx.yml(project.json)', nxConsumers()])
  for (const [f, found] of sites) {
    for (const site of found) {
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

const parse = (id) => Object.fromEntries(id.split('|').map((p) => p.split('=').map((x, i) => (i ? p.slice(p.indexOf('=') + 1) : x))))
// What fixes the cache VERSION -- i.e. which entries can match each other at
// all. @actions/cache's getCacheVersion hashes the resolved PATH LIST and the
// compression method; `enable-cross-os` contributes only on Windows. It does
// NOT hash `hash-files-glob`: that feeds hashFiles() inside the key string.
// Including the glob here was wrong, and it narrowed findPrefixCollisions to
// comparing call sites that differ only by suffix -- i.e. almost nothing.
//
// `group` IS included: with no explicit `paths`, warm-models.mjs resolves a
// per-group path list, so two groups are genuinely different versions.
const versionOf = (f) => [f.package, f['cache-version'], f.group, f.paths].join('|')

/** Every seed identity must be asked for by at least one consumer call site. */
/**
 * A parser that silently stops finding call sites would make every other check
 * pass vacuously -- a trailing comment on a `uses:` line was enough. So: any
 * workflow that mentions the action must yield at least one parsed site, and
 * the totals must not fall below what the repo is known to have.
 */
export const FLOOR = { seeds: 12, consumers: 100, nxConsumers: 10 }

export function findParserGaps(files = listWorkflows()) {
  const gaps = []
  for (const f of files) {
    const text = readFileSync(join(WORKFLOWS, f), 'utf8')
    // Only a `uses:` invocation, not a paths filter or a `node --test` path.
    // This is exactly the shape a trailing comment on the line would hide.
    if (!/uses:\s*\.\/\.github\/actions\/cache-models/.test(text)) continue
    if (parseCallSites(f).length === 0) {
      gaps.push(`${f} references cache-models but no call site parsed`)
    }
  }
  const { seeds, consumers } = collect(files)
  if (seeds.length < FLOOR.seeds) {
    gaps.push(`only ${seeds.length} seed identities parsed, expected at least ${FLOOR.seeds}`)
  }
  if (consumers.length < FLOOR.consumers) {
    gaps.push(`only ${consumers.length} consumer identities parsed, expected at least ${FLOOR.consumers}`)
  }
  // nx's identities come from packages/*/project.json, a separate parse that
  // can break independently of the workflow one.
  const nx = nxConsumers().length
  if (nx < FLOOR.nxConsumers) {
    gaps.push(`only ${nx} nx modelCache blocks parsed from packages/*/project.json, expected at least ${FLOOR.nxConsumers}`)
  }
  return gaps
}

export function findOrphanedSeeds(files) {
  const { seeds, consumers } = collect(files)
  const wanted = new Set(consumers.map((c) => c.id))
  return seeds.filter((s) => !wanted.has(s.id))
}

/**
 * Two consumers sharing a cache version must not have one key be a prefix of
 * the other. `cache-models` gives every call site the restore-key
 * `models-<package>-<version>[-<suffix>]-`, so if suffix A prefixes suffix B
 * the A leg can prefix-match B's entry, find B's larger file set already
 * present, skip its own download and save the superset under A's key. That
 * state is absorbing: A never restores just its own set again.
 *
 * An empty suffix prefixes everything in the same version, which is how the
 * audiogen functional leg absorbed the all-dit-variants benchmark set.
 */
/**
 * Prefix collisions that already exist on main.
 *
 * The nx-vs-per-addon pairs for vla and translation were here until those two
 * moved onto project.json as their single model definition -- all three
 * consumers now share one key, so there is nothing left to collide.
 *
 * Each remaining entry is a real hazard: the
 * shorter leg can prefix-match the other's entry, find its files present, skip
 * its own download and save the union under its own key. None is introduced by
 * the model-cache seeding work, and fixing them changes what other lanes
 * resolve, so they are recorded here rather than silently tolerated.
 *
 * Anything NOT on this list fails the build. Remove entries as they are fixed;
 * do not add without a ticket.
 */
export const KNOWN_COLLISIONS = [
  {
    a: 'integration-test-asr-ggml.yml',
    aSuffix: '',
    aGlob: '',
    b: 'cpp-test-coverage-asr-ggml.yml',
    bSuffix: 'cpp-tests',
    bGlob: '.github/workflows/cpp-test-coverage-asr-ggml.yml',
    why: "asr's C++ coverage lane caches packages/asr-ggml/models under suffix cpp-tests; the pin-model-manifest job's empty suffix (legacy default glob) reaches it",
  },
  {
    a: 'integration-test-asr-ggml.yml',
    aSuffix: '',
    aGlob: 'packages/asr-ggml/test/integration/*.manifest.json',
    b: 'cpp-test-coverage-asr-ggml.yml',
    bSuffix: 'cpp-tests',
    bGlob: '.github/workflows/cpp-test-coverage-asr-ggml.yml',
    why: "same, from the integration job",
  },
  {
    a: 'integration-test-asr-ggml.yml',
    aSuffix: '',
    aGlob: 'packages/asr-ggml/test/integration/*.manifest.json',
    b: 'integration-test-asr-ggml.yml',
    bSuffix: '',
    bGlob: '',
    why: "pin-model-manifest and the integration job share a path list and suffix but hash different globs, so one prefix covers both keys",
  },
]

const sig = (c) => [c.a.file, parse(c.a.id)['cache-key-suffix'], parse(c.a.id)['hash-files-glob'],
                    c.b.file, parse(c.b.id)['cache-key-suffix'], parse(c.b.id)['hash-files-glob']].join('\u0000')
const known = (k) => [k.a, k.aSuffix, k.aGlob, k.b, k.bSuffix, k.bGlob].join('\u0000')
const knownRev = (k) => [k.b, k.bSuffix, k.bGlob, k.a, k.aSuffix, k.aGlob].join('\u0000')

// Matched on BOTH sites' file, suffix AND glob. Keying on file+suffix alone was
// a blanket amnesty: three entries carry the suffix pair ('',''), so any new
// empty-suffix collision in those files was silently pardoned.
const isKnown = (c) => KNOWN_COLLISIONS.some((k) => sig(c) === known(k) || sig(c) === knownRev(k))

export function findAllPrefixCollisions(files) {
  const { consumers } = collect(files)
  const byVersion = new Map()
  for (const c of consumers) {
    const f = parse(c.id)
    if (f.package === UNRESOLVED) continue
    const v = versionOf(f)
    if (!byVersion.has(v)) byVersion.set(v, new Map())
    // key by the FULL identity, not the suffix: two sites with the same suffix
    // but different hash-files-glob produce different keys under one prefix,
    // which is the same hazard and was previously collapsed away.
    byVersion.get(v).set(c.id, { ...c, fields: f })
  }
  const out = []
  for (const [, byIdentity] of byVersion) {
    const sites = [...byIdentity.values()]
    for (const a of sites) {
      for (const b of sites) {
        if (a.id === b.id) continue
        const sa = a.fields['cache-key-suffix']
        const sb = b.fields['cache-key-suffix']
        // a's restore prefix is `models-<pkg>-<ver>[-<sa>]-`; b's key is
        // `models-<pkg>-<ver>[-<sb>]-<hash>`. a reaches b when sa is empty, when
        // the suffixes are equal (different glob => different hash, same
        // prefix), or when sb sits under sa.
        const reaches = sa === '' || sa === sb || sb.startsWith(`${sa}-`)
        if (!reaches) continue
        // report each unordered pair once unless the reach is one-directional
        const mutual = sb === '' || sa === sb || sa.startsWith(`${sb}-`)
        if (mutual && a.id > b.id) continue
        out.push({ shorter: sa, longer: sb, a, b })
      }
    }
  }
  return out
}

/** New collisions -- anything not already recorded on main. Build fails on these. */
export const findPrefixCollisions = (files) =>
  findAllPrefixCollisions(files).filter((c) => !isKnown(c))

/** Collisions that exist on main and are recorded in KNOWN_COLLISIONS. */
export const findKnownCollisions = (files) => findAllPrefixCollisions(files).filter(isKnown)

/**
 * Recorded collisions that are no longer observed.
 *
 * Without this the amnesty list doubles as a blind spot: if a parser regression
 * drops one of a call site's INPUTS, that site moves to a different version
 * bucket, its recorded collision quietly stops firing, and the run stays green
 * -- and the same regression would equally hide a NEW collision. The floors in
 * findParserGaps count sites and identities, so they do not catch it.
 *
 * A stale entry here is also just bit-rot: if someone genuinely fixes one of
 * these, the entry should be deleted rather than left as a standing pardon.
 */
export function findUnobservedKnownCollisions(files) {
  const seen = findKnownCollisions(files)
  return KNOWN_COLLISIONS.filter(
    (k) => !seen.some((c) => sig(c) === known(k) || sig(c) === knownRev(k)),
  )
}

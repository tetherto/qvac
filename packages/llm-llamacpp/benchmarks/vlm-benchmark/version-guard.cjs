'use strict'
// llama.cpp engine-version parity guard for several-sources runs.
//
// An ENGINE comparison (addon vs fabric-cli vs upstream-cli) is only fair when every
// source embeds the SAME llama.cpp build — otherwise a delta reflects the version gap,
// not the engine. The benchmark used to surface a mismatch only AFTER the run; this
// guard catches it up front, before any build or measurement.
//
// Where each source's llama.cpp build comes from (all resolvable statically):
//   • addon (any of addon / addon@candidate / addon@baseline)
//       → the `qvac-fabric` vcpkg dependency in packages/llm-llamacpp/vcpkg.json
//         (`version>=`); qvac-fabric is the company llama.cpp fork, its MAJOR is the
//         llama.cpp build number (e.g. 8828.1.0 → 8828).
//   • fabric-cli / upstream-cli
//       → the ref: a `vNNNN.*` / `bNNNN` tag carries the build number (v8189.0.2 → 8189,
//         b8189 → 8189). A 40-char commit SHA does NOT — it can't be auto-verified,
//         so it is reported as a WARNING (not a hard failure).
//
// Behaviour: ADVISORY — never blocks. A cross-version comparison is allowed (sometimes it's
// exactly what you want to benchmark); the same build is just the DEFAULT expectation. On a
// mismatch this prints a warning and the consolidated report carries a banner, so the gap is
// visible up front and in the results — without failing the run. Usage:
//   node version-guard.cjs "addon,fabric@v8189.0.2"      (or reads QVAC_VLM_SOURCES)

const fs = require('fs')
const path = require('path')
const { parseSources } = require('./sources.cjs')

// llama.cpp build number from a CLI ref: v8189.0.2 → 8189, b8189 → 8189, 8189 → 8189.
// A 40-char SHA carries no build number (→ null, unverifiable).
function buildFromRef (ref) {
  const r = String(ref || '').trim()
  if (/^[0-9a-f]{40}$/i.test(r)) return null
  const m = r.match(/^[vb]?(\d{3,})/)
  return m ? parseInt(m[1], 10) : null
}

// The addon's llama.cpp engine = the qvac-fabric vcpkg dependency's version floor.
function addonEngineBuild () {
  const vcpkgPath = path.join(__dirname, '..', '..', 'vcpkg.json')
  try {
    const j = JSON.parse(fs.readFileSync(vcpkgPath, 'utf8'))
    const dep = (j.dependencies || []).find(d => d && typeof d === 'object' && d.name === 'qvac-fabric')
    const raw = dep && (dep['version>='] || dep.version)
    const m = raw && String(raw).match(/^(\d{3,})/)
    return { build: m ? parseInt(m[1], 10) : null, raw: raw || null }
  } catch (e) {
    return { build: null, raw: null, error: e.message }
  }
}

// Build { entries:[{id,engine,build,ref,kind}], distinct, unverifiable } for a sources list.
function inspect (sourcesRaw) {
  const entries = parseSources(sourcesRaw).map(s => {
    if (s.type === 'addon') {
      const a = addonEngineBuild()
      return { id: s.id, engine: 'qvac-fabric (addon)', build: a.build, ref: a.raw, kind: 'addon' }
    }
    return { id: s.id, engine: s.type, build: buildFromRef(s.ref), ref: s.ref, kind: 'cli' }
  })
  const distinct = [...new Set(entries.filter(e => e.build != null).map(e => e.build))]
  const unverifiable = entries.filter(e => e.build == null)
  return { entries, distinct, unverifiable }
}

// Returns { ok, mismatch, warn, lines } — pure, so it's unit-testable.
function evaluate (sourcesRaw) {
  const { entries, distinct, unverifiable } = inspect(sourcesRaw)
  const lines = ['llama.cpp engine parity:']
  for (const e of entries) {
    lines.push(`  • ${e.id.padEnd(20)} ${e.engine.padEnd(22)} build ${e.build == null ? '? (ref ' + e.ref + ', unverifiable)' : e.build}`)
  }
  const mismatch = distinct.length > 1
  // Only the comparison itself matters: <2 sources, or one engine, can't mismatch.
  const warn = !mismatch && unverifiable.length > 0 && entries.length > 1
  return { ok: !mismatch, mismatch, warn, distinct, unverifiable, entries, lines }
}

function main () {
  const sourcesRaw = process.argv[2] || process.env.QVAC_VLM_SOURCES || ''
  const r = evaluate(sourcesRaw)
  for (const l of r.lines) console.log(l)
  if (r.mismatch) {
    console.log(`\n⚠ CROSS-VERSION comparison: sources do not share one llama.cpp build (found ${r.distinct.join(', ')}).`)
    console.log('  Allowed (sometimes intended) — NOT a failure; the report flags it. For an apples-to-apples')
    console.log('  engine comparison, pin every source to the same build (e.g. fabric/upstream tag → the')
    console.log('  addon\'s qvac-fabric build).')
  } else if (r.warn) {
    console.log('\n⚠ A source is pinned to a commit SHA — its build is not derivable from the ref;')
    console.log('  parity could not be auto-verified. Confirm manually that the SHA matches the others.')
  } else {
    console.log('\n✓ all sources share llama.cpp build ' + (r.distinct[0] != null ? r.distinct[0] : '(single source / nothing to compare)') + '.')
  }
}

if (require.main === module) main()

module.exports = { buildFromRef, addonEngineBuild, inspect, evaluate }

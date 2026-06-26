'use strict'
// Auto-select one llama.cpp build supported by EVERY requested source, so a
// several-sources engine comparison is apples-to-apples by default. The chosen build is
// the MOST RECENT one present in the intersection of all sources' available builds.
//
//   • addon (any addon variant) → a single fixed build: the qvac-fabric vcpkg pin
//     (packages/llm-llamacpp/vcpkg.json). The addon can't be re-versioned per run, so when
//     it's in the set the common build can be at most its build.
//   • fabric-cli / upstream-cli → the set of builds their repo has tagged (git ls-remote):
//     fabric `vN.x.y` → build N (highest x.y wins as the tag); upstream `bN` → build N.
//
// Mode: AUTO when no CLI source carries an explicit @ref (resolve to the common build);
// MANUAL when any does (honor the given refs — versions may differ, reported as such).
// Pure derivation + git ls-remote; no deps. Used by the workflow context step (to set the
// build refs) and surfaced in the report's "Engine versions" table.

const cp = require('child_process')
const { addonEngineBuild, buildFromRef } = require('./version-guard.cjs')

let CLI = {}
try { CLI = require('./cli-source-config.js') } catch (_) {}
const REPO = { 'fabric-cli': CLI.fabric && CLI.fabric.repo, 'upstream-cli': CLI.upstream && CLI.upstream.repo }

function parseTokens (raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean)
}

// git ls-remote --tags → unique tag names (strip the ^{} annotated-tag peels).
function lsRemoteTags (repo) {
  const out = cp.execFileSync('git', ['ls-remote', '--tags', repo], { encoding: 'utf8', timeout: 30000 })
  const tags = new Set()
  for (const line of out.split('\n')) {
    const m = line.match(/refs\/tags\/(.+?)(\^\{\})?$/)
    if (m) tags.add(m[1])
  }
  return [...tags]
}

// build number → best tag for a CLI engine. fabric: vN.x.y (highest x.y per build N);
// upstream: bN.
function buildsForEngine (engine, tags) {
  const by = new Map()
  for (const t of tags) {
    if (engine === 'fabric-cli') {
      const m = t.match(/^v(\d+)\.(\d+)\.(\d+)$/)
      if (!m) continue
      const b = +m[1]; const rank = +m[2] * 1e6 + +m[3]
      const cur = by.get(b)
      if (!cur || rank > cur.rank) by.set(b, { tag: t, rank })
    } else { // upstream-cli
      const m = t.match(/^b(\d+)$/)
      if (m) by.set(+m[1], { tag: t, rank: 0 })
    }
  }
  return by
}

// Resolve the requested sources to a single shared build (AUTO) or honor explicit refs
// (MANUAL). Returns { mode, target, sources:[{engine, chosenBuild, chosenTag, latestBuild,
// latestTag}], fabric_ref, upstream_ref }.
function resolve (sourcesRaw) {
  const toks = parseTokens(sourcesRaw)
  const explicit = toks.some(t => /^(fabric|upstream)@./.test(t))
  const mode = explicit ? 'manual' : 'auto'

  const info = []
  for (const t of toks) {
    const kind = t.split('@')[0]
    const ref = t.includes('@') ? t.slice(t.indexOf('@') + 1) : ''
    if (kind === 'addon') {
      const b = addonEngineBuild().build
      info.push({ engine: 'addon', kind: 'addon', builds: new Map(b != null ? [[b, { tag: String(b) }]] : []), latest: b })
    } else if (kind === 'fabric' || kind === 'upstream') {
      const engine = kind === 'fabric' ? 'fabric-cli' : 'upstream-cli'
      const repo = REPO[engine]
      const by = repo ? buildsForEngine(engine, lsRemoteTags(repo)) : new Map()
      const latest = by.size ? Math.max(...by.keys()) : null
      info.push({ engine, kind: 'cli', builds: by, latest, ref: ref || (engine === 'fabric-cli' ? 'v8189.0.2' : 'b8189') })
    }
  }

  // AUTO target = most recent build in the intersection of every source's build set.
  let target = null
  if (mode === 'auto' && info.length) {
    let inter = null
    for (const i of info) { const ks = new Set(i.builds.keys()); inter = inter == null ? ks : new Set([...inter].filter(x => ks.has(x))) }
    const common = inter ? [...inter] : []
    target = common.length ? Math.max(...common) : null
  }

  const sources = info.map(i => {
    const latestTag = i.kind === 'addon' ? (i.latest != null ? String(i.latest) : null) : (i.latest != null && i.builds.get(i.latest) ? i.builds.get(i.latest).tag : null)
    let chosenBuild; let chosenTag
    if (mode === 'auto' && target != null) {
      chosenBuild = i.kind === 'addon' ? i.latest : target
      chosenTag = i.kind === 'addon' ? String(i.latest) : (i.builds.get(target) ? i.builds.get(target).tag : null)
    } else if (mode === 'manual') {
      chosenTag = i.kind === 'addon' ? (i.latest != null ? String(i.latest) : null) : i.ref
      chosenBuild = i.kind === 'addon' ? i.latest : buildFromRef(i.ref)
    } else { // auto with no common build → fall back to each source's own latest (a mismatch)
      chosenBuild = i.latest; chosenTag = latestTag
    }
    return { engine: i.engine, chosenBuild, chosenTag, latestBuild: i.latest, latestTag }
  })

  const fab = sources.find(s => s.engine === 'fabric-cli')
  const up = sources.find(s => s.engine === 'upstream-cli')
  return { mode: target == null && mode === 'auto' ? 'auto-nocommon' : mode, target, sources, fabric_ref: fab ? fab.chosenTag : null, upstream_ref: up ? up.chosenTag : null }
}

function main () {
  const raw = process.argv[2] || process.env.QVAC_VLM_SOURCES || ''
  const r = resolve(raw)
  const b64 = Buffer.from(JSON.stringify({ mode: r.mode, sources: r.sources })).toString('base64')
  // GITHUB_OUTPUT-friendly lines (the context step appends our stdout to $GITHUB_OUTPUT).
  if (r.fabric_ref) console.log('fabric_ref=' + r.fabric_ref)
  if (r.upstream_ref) console.log('upstream_ref=' + r.upstream_ref)
  console.log('version_mode=' + r.mode)
  console.log('versions_b64=' + b64)
}

if (require.main === module) main()

module.exports = { resolve, lsRemoteTags, buildsForEngine }

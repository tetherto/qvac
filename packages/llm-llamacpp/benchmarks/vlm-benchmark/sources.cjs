'use strict'
// SOURCES — the builds-under-comparison axis.
// A "source" is one thing being measured: the addon at some version, or one of the
// native CLIs (fabric = the company llama.cpp fork, upstream = original llama.cpp).
// Selected per run via the `matrix_sources` workflow input
// (tokens: addon | addon@candidate | addon@baseline | fabric@<ref> | upstream@<ref>).
// The report side never imports this — it sees sources only as the
// `source_id`/`source_ref` marker fields. Source types:
//   addon            — the published npm prebuild
//   addon@candidate  — prebuild built from the dispatched ref
//   addon@baseline   — pinned npm version (per-model / defaultBaseline)
//   fabric/upstream  — native CLIs over the several-sources path; ref = tag, branch,
//                      or full commit SHA (SHA-keyed build cache)

// Parse one matrix_sources token into { id, type, ref }.
function parseSourceToken (token) {
  const t = String(token || '').trim()
  if (!t) return null
  const at = t.indexOf('@')
  const kind = at === -1 ? t : t.slice(0, at)
  const ref = at === -1 ? '' : t.slice(at + 1)
  switch (kind) {
    case 'addon':
      if (ref && ref !== 'candidate' && ref !== 'baseline') {
        throw new Error(`addon source ref must be 'candidate' or 'baseline' (got '${t}')`)
      }
      return { id: t, type: 'addon', ref: ref || 'published' }
    case 'fabric':
      return { id: t, type: 'fabric-cli', ref: ref || 'v8189.0.2' }
    case 'upstream':
      return { id: t, type: 'upstream-cli', ref: ref || 'b8189' }
    default:
      throw new Error(`unknown source '${t}' (known: addon[@candidate|@baseline], fabric@<ref>, upstream@<ref>)`)
  }
}

function parseSources (raw) {
  return String(raw || '').split(',').map(parseSourceToken).filter(Boolean)
}

// Resolve an addon source to the prebuilds dir the harness should load — the whole
// native build (the require.addon() binding AND the compute backends), so a run uses
// candidate or baseline end to end. CI stages these:
//   addon@candidate → builds/candidate/prebuilds (built from the PR ref)
//   addon@baseline  → builds/baseline/prebuilds  (pinned published npm version)
//   addon           → the workspace prebuilds, loaded in place (no swap)
function addonPrebuildDir (source, workdir) {
  const ref = source && source.ref
  if (ref === 'candidate') return `${workdir}/builds/candidate/prebuilds`
  if (ref === 'baseline') return `${workdir}/builds/baseline/prebuilds`
  return `${workdir}/prebuilds`
}

module.exports = { parseSourceToken, parseSources, addonPrebuildDir }

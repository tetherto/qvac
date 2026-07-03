'use strict'
// Combine driver — everything the workflow's matrix-combine job does after downloading
// artifacts, kept in this folder so report changes never touch the workflow YAML.
// Discovers per-leg logs, tags each with its platform host, synthesizes mobile
// provenance, and renders the consolidated report via aggregate.js. The benchmark is
// descriptive (no accuracy gate): the run is green as long as it produced a report.
//
//   node combine.cjs --dir matrix-logs --out consolidated/report.md \
//     --title "…" --mode two-models --engine addon --run-number 7
//
// Host-tagging rules:
//   • desktop logs vlm-matrix-<host>-<backend>.log → host from the filename
//   • Android logcat_full / iOS bare_console      → host = device-model slug
//     (Galaxy_S25→s25, Pixel_9→pixel9, iPhone_17_Pro→iphone17pro); files with
//     no device in the name are the collector's generic duplicates → skipped.

const fs = require('fs')
const path = require('path')
const { parseLog, build } = require('./aggregate.js')

const DEVICE_RE = /Galaxy_S[0-9]+|Pixel_[0-9]+|iPhone_[0-9]+(_Pro(_Max)?)?/

function hostOf (file) {
  const m = path.basename(file).match(DEVICE_RE)
  if (!m) return null
  return m[0].toLowerCase().replace(/^galaxy_/, '').replace(/_/g, '')
}

function walk (dir) {
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function parseArgs (argv) {
  const a = { dir: 'matrix-logs', out: null, title: 'VLM Matrix', mode: '', engine: '', preset: process.env.QVAC_VLM_PRESET || '', runNumber: '', versionsB64: process.env.QVAC_VLM_VERSIONS_B64 || '' }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dir') a.dir = argv[++i]
    else if (argv[i] === '--out') a.out = argv[++i]
    else if (argv[i] === '--title') a.title = argv[++i]
    else if (argv[i] === '--mode') a.mode = argv[++i]
    else if (argv[i] === '--engine') a.engine = argv[++i]
    else if (argv[i] === '--preset') a.preset = argv[++i]
    else if (argv[i] === '--run-number') a.runNumber = argv[++i]
    // base64'd JSON from resolve-versions.cjs ({mode, sources:[{engine,chosenTag,latestTag}]})
    // → the report's "Engine versions" table. Defaults to QVAC_VLM_VERSIONS_B64.
    else if (argv[i] === '--versions-b64') a.versionsB64 = argv[++i]
  }
  return a
}

function main () {
  const args = parseArgs(process.argv)
  const files = walk(args.dir).sort()
  const lc = f => path.basename(f).toLowerCase()

  // ── inputs: [host label, file] pairs ────────────────────────────────────
  const inputs = []
  for (const f of files) {
    const m = path.basename(f).match(/^vlm-matrix-([a-z0-9]+)-[a-z]+\.log$/)
    if (m) inputs.push({ label: m[1], file: f })
  }
  for (const f of files) {
    if (!lc(f).includes('logcat_full')) continue
    const h = hostOf(f)
    if (h) inputs.push({ label: h, file: f })
  }
  for (const f of files) {
    if (!(f.includes('iOS') && lc(f).includes('bare_console'))) continue
    const h = hostOf(f)
    if (h) inputs.push({ label: h, file: f })
  }

  // ── provenance: desktop prov-*.md as-is + synthesized mobile blocks ─────
  const prov = []
  for (const f of files) if (/^prov-.*\.md$/.test(path.basename(f))) prov.push(fs.readFileSync(f, 'utf8'))
  const seen = new Set()
  for (const f of files) {
    if (!lc(f).includes('logcat_full')) continue
    const h = hostOf(f)
    if (!h || seen.has(h)) continue
    seen.add(h)
    const txt = fs.readFileSync(f, 'utf8')
    const pick = (re) => { const m = txt.match(re); return m ? m[1] : null }
    const devName = (path.basename(f).match(/(Samsung|Google)_[A-Za-z0-9_]*/) || [''])[0]
      .replace(/_logcat_full.*/, '').replace(/_/g, ' ')
    const ramB = parseInt(pick(/totalMemory: (\d+)/) || '0', 10)
    prov.push([
      `**${h}** — ${devName || 'Android device'} (AWS Device Farm)`,
      `- device: ${pick(/model=([A-Za-z0-9-]+)/) || '?'} · Android ${pick(/platformVersionRelease=(\d+)/) || '?'} · ${pick(/supportedAbis=([a-z0-9-]+)/) || 'arm64-v8a'}`,
      `- ram: ${ramB ? (ramB / 1073741824).toFixed(1) + ' GB' : '?'} · gpu: ${/AdrenoVK|vulkan\.adreno/i.test(txt) ? 'Adreno (Vulkan)' : '?'}`,
      '- engine: `@qvac/llm-llamacpp` addon (published prebuild)'
    ].join('\n'))
  }
  for (const f of files) {
    if (!(f.includes('iOS') && lc(f).includes('bare_console'))) continue
    const h = hostOf(f)
    if (!h || seen.has(h)) continue
    seen.add(h)
    const dev = (path.basename(f).match(/Apple_[A-Za-z0-9_]*/) || [''])[0]
      .replace(/_bare_console.*/, '').replace(/_/g, ' ')
    prov.push([
      `**${h}** — ${dev || 'Apple iPhone'} (AWS Device Farm)`,
      '- engine: `@qvac/llm-llamacpp` addon (published prebuild)'
    ].join('\n'))
  }

  console.error('combine inputs: ' + (inputs.map(i => `[${i.label}] ${i.file}`).join('\n                ') || '(none)'))

  let md
  if (!inputs.length) {
    md = `> No VLM matrix logs found for run #${args.runNumber || '?'}.`
  } else {
    const { rows, vision, meta } = parseLog(inputs)
    // Two-models Highlights compare a base cell vs a candidate cell by LABEL.
    // With launch-time models (matrix_models) the labels can be anything, so
    // derive them from the rows: the committed config pair when both actually
    // ran, else the first two distinct cells in marker order.
    let base, candidate
    if (args.mode !== 'several-sources') {
      const cells = [...new Set(rows.map(r => r.cell).filter(Boolean))]
      let CONFIG = {}
      try { CONFIG = require('./config.cjs') } catch (_) {}
      if (cells.includes(CONFIG.base) && cells.includes(CONFIG.candidate)) {
        base = CONFIG.base
        candidate = CONFIG.candidate
      } else {
        base = cells[0]
        candidate = cells[1]
      }
    }
    let versions = null
    try { if (args.versionsB64) versions = JSON.parse(Buffer.from(args.versionsB64, 'base64').toString('utf8')) } catch (_) {}
    md = build(rows, vision, meta, prov.join('\n\n'), args.title,
      { mode: args.mode, engine: args.engine, preset: args.preset, base, candidate, versions })
  }
  process.stdout.write(md + '\n')
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true })
    fs.writeFileSync(args.out, md + '\n')
  }
  // No quality gate: this benchmark reports how good the models are per task (and one
  // model across sources); it does not compare a candidate vs a baseline of the SAME
  // model, so there's nothing to gate on. The run is green as long as it produced a report.
}

if (require.main === module) main()

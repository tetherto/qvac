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

  // ── provenance: desktop prov-*.md + synthesized mobile blocks ─────
  // Launch-level source facts (addon/git/engine lines) are identical for every
  // platform in one run, so they are hoisted OUT of the per-platform blocks
  // into `launch` and rendered once under the report's Sources section.
  const prov = []
  const launch = new Set()
  // 'git' kept for prov files from older benchmark-code checkouts (renamed to
  // 'benchmark code' to disambiguate from the Sources table's git:<sha>, which is
  // an addon@candidate BUILD source — this line is the benchmark-code checkout).
  const LAUNCH_LINE = /^- (addon|git|benchmark code|engine): /
  for (const f of files) {
    if (!/^prov-.*\.md$/.test(path.basename(f))) continue
    const kept = []
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (LAUNCH_LINE.test(line)) launch.add(line.replace(/^- /, ''))
      else kept.push(line)
    }
    prov.push(kept.join('\n'))
  }
  // GPU model from the device driver's own logcat lines: concrete model when the
  // driver printed one (Qualcomm "Adreno (TM) 840", ARM "Mali-G715"), family from
  // the Vulkan HAL library name as fallback. Matching is deliberately narrow —
  // a bare /mali/i would hit unrelated words (e.g. "maliciousFiles" in app logs).
  const gpuOf = (txt) => {
    const adreno = txt.match(/Adreno\s*\(TM\)\s*(\d{3})/i)
    if (adreno) return `Adreno ${adreno[1]} (Vulkan)`
    const mali = txt.match(/Mali-G(\d+)/i)
    if (mali) return `Mali-G${mali[1]} (Vulkan)`
    if (/AdrenoVK|vulkan\.adreno/i.test(txt)) return 'Adreno (Vulkan)'
    if (/vulkan\.mali/i.test(txt)) return 'Mali (Vulkan)'
    return '?'
  }
  const MOBILE_ENGINE = 'engine: `@qvac/llm-llamacpp` addon (published prebuild)'
  const seen = new Set()
  for (const f of files) {
    if (!lc(f).includes('logcat_full')) continue
    const h = hostOf(f)
    if (!h || seen.has(h)) continue
    seen.add(h)
    const txt = fs.readFileSync(f, 'utf8')
    const pick = (re) => { const m = txt.match(re); return m ? m[1] : null }
    // The capability lines (model=…, platformVersionRelease=…) are not reliably
    // present in logcat — some sessions never echo them there. The per-device
    // appium log always carries the session's device JSON
    // ("model":"SM-S942U1" … "platformVersion":"16"); fall back to it for any
    // field the logcat pick missed.
    const appiumFile = files.find(x => hostOf(x) === h && /appium/i.test(path.basename(x)))
    const appium = appiumFile ? fs.readFileSync(appiumFile, 'utf8') : ''
    const pickA = (re) => { const m = appium.match(re); return m ? m[1] : null }
    // Appium first: its JSON field is the full ro.product.model ("Pixel 9",
    // "SM-S942U1"); logcat's space-delimited `model=` capability truncates
    // multi-word models ("Pixel 9" -> "Pixel") and is missing entirely in
    // some sessions.
    const devModel = pickA(/"model":"([A-Za-z0-9 ._-]+)"/) || pick(/model=([A-Za-z0-9-]+)/)
    const androidVer = pickA(/"platformVersion":"([0-9.]+)"/) || pick(/platformVersionRelease=(\d+)/)
    // Device name = the LAST manufacturer-prefixed segment of the filename
    // (<df-run-name>_<device-name>_logcat_full…). The DF run name embeds the
    // exact model too (EQUALS tokens), so a greedy first-match would render the
    // name twice ("Google Pixel 9 Google Pixel 9").
    const stem = path.basename(f).replace(/_logcat_full.*/, '')
    const di = Math.max(stem.lastIndexOf('Samsung_'), stem.lastIndexOf('Google_'))
    const devName = di >= 0 ? stem.slice(di).replace(/_/g, ' ') : ''
    const ramB = parseInt(pick(/totalMemory: (\d+)/) || '0', 10)
    launch.add(MOBILE_ENGINE)
    prov.push([
      `**${h}** — ${devName || 'Android device'} (AWS Device Farm)`,
      `- device: ${devModel || '?'} · Android ${androidVer || '?'} · ${pick(/supportedAbis=([a-z0-9-]+)/) || 'arm64-v8a'}`,
      `- ram: ${ramB ? (ramB / 1073741824).toFixed(1) + ' GB' : '?'} · gpu: ${gpuOf(txt)}`
    ].join('\n'))
  }
  for (const f of files) {
    if (!(f.includes('iOS') && lc(f).includes('bare_console'))) continue
    const h = hostOf(f)
    if (!h || seen.has(h)) continue
    seen.add(h)
    // Same last-occurrence rule as the Android block: the DF run name embeds
    // the exact model, so the filename carries "Apple_iPhone…" twice.
    const iosStem = path.basename(f).replace(/_bare_console.*/, '')
    const ai = iosStem.lastIndexOf('Apple_')
    const dev = ai >= 0 ? iosStem.slice(ai).replace(/_/g, ' ') : ''
    launch.add(MOBILE_ENGINE)
    prov.push([
      `**${h}** — ${dev || 'Apple iPhone'} (AWS Device Farm)`
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
      { mode: args.mode, engine: args.engine, preset: args.preset, base, candidate, versions, launch: [...launch] })
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

'use strict'
// Regenerate the VLM matrix fixture from open-licensed lmms datasets.
//
// Iterates the HuggingFace datasets-server (which returns each image's width/height
// in the /rows response, so we filter on resolution WITHOUT downloading), keeps only
// samples whose longest side is <= --max-side, picks --per-task per task skewed small
// (with spread), then downloads just the chosen images into ./fixture/ and rewrites
// ./fixture.data.cjs + ./fixture.NOTICE.md.
//
// No manual resizing — only natural samples that already match the resolution policy.
// Only datasets on the open-licence allowlist are accepted (public repo).
//
// Images are NOT committed to git (fixture/ is git-ignored except its README). After
// regenerating, upload fixture/ to the fixture object store (the fixture's source of
// truth; URI configured in the benchmark workflow) so CI can fetch them, e.g.
// `aws s3 sync ./fixture/ <fixture-store-uri>`.
//
// Usage: node benchmarks/vlm-benchmark/build-fixture.cjs [--per-task 3] [--max-side 1024] [--scan 2000]

const fs = require('fs')
const path = require('path')
const https = require('https')

// fixture/ is git-ignored (except README) and S3-backed; this writes the chosen images
// here locally for upload to S3. CI syncs S3 -> fixture/, then stage.cjs copies them
// into testAssets.
const IMAGES_DIR = path.join(__dirname, 'fixture')
const FIXTURE = path.join(__dirname, 'fixture.data.cjs')
const NOTICE = path.join(__dirname, 'fixture.NOTICE.md')
const TOKEN = process.env.HF_TOKEN || ''

const ALLOW_LICENSES = new Set(['CC-BY-4.0', 'CC-BY-SA-4.0', 'Apache-2.0', 'MIT', 'CC0-1.0'])
const VQA_PROMPT_SUFFIX = '\nAnswer the question using a single word or phrase.'

// Open-licensed tasks. `kind: bundled` = one config with image+QA; `kind: gqa` joins a
// separate images config to an instructions config on imageId.
const TASKS = {
  textvqa: { dataset: 'lmms-lab/textvqa', config: 'default', split: 'validation', kind: 'bundled', q: 'question', answers: 'answers', metric: 'vqa', license: 'CC-BY-4.0', attribution: 'TextVQA — images from OpenImages (CC-BY-4.0)' },
  vizwiz: { dataset: 'lmms-lab/VizWiz-VQA', config: 'default', split: 'val', kind: 'bundled', q: 'question', answers: 'answers', metric: 'vqa', license: 'CC-BY-4.0', attribution: 'VizWiz-VQA (CC-BY-4.0)' },
  gqa: { dataset: 'lmms-lab/GQA', kind: 'gqa', instr: { config: 'testdev_balanced_instructions', split: 'testdev' }, imgs: { config: 'testdev_balanced_images', split: 'testdev' }, metric: 'vqa', license: 'CC-BY-4.0', attribution: 'GQA — images from Visual Genome (CC-BY-4.0)' },
  docvqa: { dataset: 'lmms-lab/DocVQA', config: 'DocVQA', split: 'validation', kind: 'bundled', q: 'question', answers: 'answers', metric: 'anls', license: 'Apache-2.0', attribution: 'DocVQA — UCSF Industry Documents Library (Apache-2.0)' },
  // InfographicVQA is excluded: its images are inherently > 1024 px (tall infographics).
  // AI2D (diagrams, multiple-choice) gives a 5th open task that stays small.
  ai2d: { dataset: 'lmms-lab/ai2d', config: 'default', split: 'test', kind: 'ai2d', metric: 'mc', license: 'CC-BY-SA-4.0', attribution: 'AI2D — AI2 Diagrams (CC-BY-SA-4.0)' }
}

function arg (name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def }
const PER_TASK = parseInt(arg('per-task', '3'), 10)
const MAX_SIDE = parseInt(arg('max-side', '1024'), 10)
const SCAN = parseInt(arg('scan', '2000'), 10)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function fetchOnce (url) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'qvac-vlm-fixture-builder' }
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
    https.get(url, { headers }, (res) => {
      let b = ''
      res.on('data', d => { b += d })
      res.on('end', () => resolve({ status: res.statusCode, body: b }))
    }).on('error', e => resolve({ status: 0, body: String(e) }))
  })
}

// datasets-server rate-limits (429 → HTML page); retry with exponential backoff.
async function getJson (url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const res = await fetchOnce(url)
    if (res.status === 200) { try { return JSON.parse(res.body) } catch (_) {} }
    if (res.status === 429 || res.status >= 500 || res.status === 0) {
      const wait = 1500 * Math.pow(2, i)
      console.warn(`  ${res.status || 'neterr'} — backoff ${wait}ms`)
      await sleep(wait); continue
    }
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 150)}`)
  }
  throw new Error('exhausted retries (rate-limited)')
}

function download (url, dest) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'qvac-vlm-fixture-builder' }
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(download(new URL(res.headers.location, url).toString(), dest))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)) }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => out.close(resolve))
      out.on('error', reject)
    }).on('error', reject)
  })
}

const rowsUrl = (ds, config, split, offset, length) =>
  `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(ds)}&config=${encodeURIComponent(config)}&split=${split}&offset=${offset}&length=${length}`

async function scanRows (ds, config, split, onRow) {
  for (let off = 0; off < SCAN; off += 100) {
    let data
    try { data = await getJson(rowsUrl(ds, config, split, off, 100)) } catch (e) { console.warn(`  scan stop @${off}: ${e.message}`); break }
    const rows = (data && data.rows) || []
    if (!rows.length) break
    for (const it of rows) if (onRow(it.row) === 'enough') return
    await sleep(500)
  }
}

const extOf = (src) => { const m = String(src).match(/\.(png|jpe?g|webp|gif)(?:[?#]|$)/i); return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg' }
const longest = (c) => Math.max(c.w, c.h)
const modal = (arr) => { const m = {}; let best = null; for (const a of arr) { m[a] = (m[a] || 0) + 1; if (!best || m[a] > m[best]) best = a } return best }

// Normalise gold to an array of answer strings.
function golds (raw) {
  if (!Array.isArray(raw)) return [String(raw)]
  return raw.map(a => (a && typeof a === 'object' && 'answer' in a) ? a.answer : a).map(String)
}

async function collectBundled (t) {
  const cands = []
  await scanRows(t.dataset, t.config, t.split, (row) => {
    const img = row[row.image ? 'image' : 'image']
    if (!img || !img.width) return
    if (Math.max(img.width, img.height) > MAX_SIDE) return
    const g = golds(row[t.answers])
    if (!g.length) return
    if (t.metric === 'vqa' && modal(g).toLowerCase() === 'unanswerable') return // skip degenerate VizWiz items
    cands.push({ q: String(row[t.q]), gold: g, src: img.src, w: img.width, h: img.height })
    if (cands.length >= 80) return 'enough'
  })
  return cands
}

async function collectAi2d (t) {
  const cands = []
  await scanRows(t.dataset, t.config, t.split, (row) => {
    const img = row.image
    if (!img || !img.width || Math.max(img.width, img.height) > MAX_SIDE) return
    const opts = row.options
    const idx = parseInt(row.answer, 10)
    if (!Array.isArray(opts) || opts.length < 2 || !(idx >= 0 && idx < opts.length)) return
    const letters = opts.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')
    cands.push({
      q: String(row.question),
      promptOverride: `${row.question}\n${letters}\nAnswer with ONLY the letter (for example, A) of the correct option, and nothing else.`,
      gold: [String.fromCharCode(65 + idx)],
      src: img.src,
      w: img.width,
      h: img.height
    })
    if (cands.length >= 80) return 'enough'
  })
  return cands
}

async function collectGqa (t) {
  const imgMap = {}
  await scanRows(t.dataset, t.imgs.config, t.imgs.split, (row) => {
    if (row.image && row.image.width && Math.max(row.image.width, row.image.height) <= MAX_SIDE) {
      imgMap[row.id] = { src: row.image.src, w: row.image.width, h: row.image.height }
    }
    if (Object.keys(imgMap).length >= 300) return 'enough'
  })
  const cands = []
  await scanRows(t.dataset, t.instr.config, t.instr.split, (row) => {
    const im = imgMap[row.imageId]
    if (!im) return
    cands.push({ q: String(row.question), gold: [String(row.answer)], src: im.src, w: im.w, h: im.h })
    if (cands.length >= 80) return 'enough'
  })
  return cands
}

// Pick PER_TASK items skewed small but spread across the available <=MAX_SIDE range.
function pick (candsRaw) {
  const seenSrc = new Set()
  const cands = candsRaw.filter(c => { const k = c.src.replace(/\?.*$/, ''); if (seenSrc.has(k)) return false; seenSrc.add(k); return true })
  if (cands.length <= PER_TASK) return cands
  const sorted = cands.slice().sort((a, b) => longest(a) - longest(b))
  const fracs = PER_TASK === 3 ? [0.1, 0.4, 0.75] : Array.from({ length: PER_TASK }, (_, i) => (i + 0.5) / PER_TASK)
  const seen = new Set()
  const out = []
  for (const f of fracs) {
    let idx = Math.min(sorted.length - 1, Math.floor(f * sorted.length))
    while (seen.has(idx) && idx < sorted.length - 1) idx++
    while (seen.has(idx) && idx > 0) idx--
    seen.add(idx); out.push(sorted[idx])
  }
  return out
}

async function main () {
  fs.mkdirSync(IMAGES_DIR, { recursive: true })
  const items = []
  const notice = ['# VLM fixture — image sources & licences', '', 'Auto-generated by `benchmarks/vlm-benchmark/build-fixture.cjs`. All datasets are on the open-licence allowlist.', '']
  const taskNames = Object.keys(TASKS)

  for (const task of taskNames) {
    const t = TASKS[task]
    if (!ALLOW_LICENSES.has(t.license)) throw new Error(`${task}: licence ${t.license} not in allowlist`)
    console.log(`\n[${task}] scanning (<=${MAX_SIDE}px, metric=${t.metric}, ${t.license})`)
    const cands = t.kind === 'gqa' ? await collectGqa(t) : t.kind === 'ai2d' ? await collectAi2d(t) : await collectBundled(t)
    console.log(`  ${cands.length} candidates <=${MAX_SIDE}px`)
    if (!cands.length) { console.warn(`  !! no candidates for ${task} — skipping`); continue }
    const chosen = pick(cands)
    notice.push(`## ${task} — ${t.attribution}`)
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i]
      const image = `vlmx-${task}_${i}.${extOf(c.src)}`
      console.log(`  -> ${image} ${c.w}x${c.h}`)
      await download(c.src, path.join(IMAGES_DIR, image))
      items.push({ id: `${task}_${i}`, task, metric: t.metric, prompt: c.promptOverride || (c.q + VQA_PROMPT_SUFFIX), gold: c.gold, image, width: c.w, height: c.h, license: t.license })
      notice.push(`- \`${image}\` (${c.w}×${c.h})`)
      await sleep(120)
    }
    notice.push('')
  }

  const present = new Set(taskNames.filter(tn => items.some(it => it.task === tn)))
  const data = { tasks: [...present], samplesPerTask: PER_TASK, items }
  const header = `/* eslint-disable */\n'use strict'\n// VLM benchmark fixture — AUTO-GENERATED by benchmarks/vlm-benchmark/build-fixture.cjs.\n// Open-licensed samples (see fixture.NOTICE.md), longest side <= ${MAX_SIDE}px. Generated\n// data (JSON shape) — lint disabled so the machine-written quoting doesn't trip standard.\nmodule.exports = `
  fs.writeFileSync(FIXTURE, header + JSON.stringify(data, null, 2) + '\n')
  fs.writeFileSync(NOTICE, notice.join('\n') + '\n')

  // Prune fixture/ entries no longer referenced (e.g. dropped tasks).
  const keep = new Set(items.map(it => it.image))
  for (const f of fs.readdirSync(IMAGES_DIR)) {
    if (/^vlmx-.*\.(png|jpe?g|webp|gif)$/i.test(f) && !keep.has(f)) { fs.rmSync(path.join(IMAGES_DIR, f)); console.log(`pruned images/${f}`) }
  }
  console.log(`\nWrote ${items.length} items across ${present.size} tasks -> ${path.relative(__dirname, FIXTURE)}`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })

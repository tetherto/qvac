'use strict'

/**
 * ABot-World interactive walk — browser demo.
 *
 * Serves a local web page with a video window and WASD/IJKL keyboard control
 * driving an ABot-World session (@qvac/diffusion-cpp/world). The server runs
 * a block-by-block walk loop: each block is generated under whichever keys
 * the browser currently holds, decoded to PNG frames, and streamed to the
 * page, which plays them at a fixed frame rate.
 *
 * Usage:
 *   ABOT_MODELS_DIR=/path/to/models bare examples/world-walk-server.js
 *
 * ABOT_MODELS_DIR must contain:
 *   abot-world-0-5b-lf-dit-q8_0.gguf   (or set ABOT_DIT to a specific file)
 *   taew2_2_f16.gguf                   (or set ABOT_TAEHV)
 *   scene.safetensors                  (or set ABOT_SCENE)
 *
 * Optional env: HOST (127.0.0.1), PORT (8787), ABOT_THREADS, ABOT_SEED,
 * ABOT_BACKEND (e.g. "cpu", "cuda").
 */

const http = require('bare-http1')
const process = require('bare-process')
const path = require('bare-path')
const fs = require('bare-fs')
const WorldStableDiffusion = require('@qvac/diffusion-cpp/world')

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const MAX_BODY_BYTES = 64 * 1024
const FRAME_RING_SIZE = 64

function resolveModelFile(envKey, fallbackNames) {
  if (process.env[envKey]) return process.env[envKey]
  const dir = process.env.ABOT_MODELS_DIR
  if (!dir) {
    console.error(
      `world-walk-server: set ABOT_MODELS_DIR (or ${envKey}) — need ` +
        `${fallbackNames.join(' / ')}`
    )
    process.exit(1)
  }
  for (const name of fallbackNames) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  console.error(`world-walk-server: none of ${fallbackNames.join(', ')} found in ${dir}`)
  process.exit(1)
}

const DIT_PATH = resolveModelFile('ABOT_DIT', [
  'abot-world-0-5b-lf-dit-q8_0.gguf',
  'abot-world-0-5b-lf-dit-f16.gguf'
])
const TAEHV_PATH = resolveModelFile('ABOT_TAEHV', ['taew2_2_f16.gguf'])
const SCENE_PATH = resolveModelFile('ABOT_SCENE', ['scene.safetensors'])

const world = new WorldStableDiffusion({
  files: { model: DIT_PATH, taehv: TAEHV_PATH, scene: SCENE_PATH },
  config: {
    threads: process.env.ABOT_THREADS || undefined,
    seed: process.env.ABOT_SEED || undefined,
    backend: process.env.ABOT_BACKEND || undefined
  },
  opts: { stats: true }
})

// ── walk state ───────────────────────────────────────────────────────────────
const state = {
  loaded: false,
  running: false,
  generating: false,
  block: 0,
  lastStepMs: 0,
  error: null,
  keys: { W: false, A: false, S: false, D: false, I: false, J: false, K: false, L: false }
}
const frames = [] // ring of { index, png:Buffer }
let nextFrameIndex = 0

function pushFrame(png) {
  frames.push({ index: nextFrameIndex++, png })
  while (frames.length > FRAME_RING_SIZE) frames.shift()
}

async function walkLoop() {
  while (state.running) {
    state.generating = true
    const t0 = Date.now()
    try {
      const response = await world.step({ ...state.keys })
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) pushFrame(Buffer.from(data))
        })
        .await()
      state.block++
      state.lastStepMs = Date.now() - t0
    } catch (err) {
      state.error = String(err?.message || err)
      state.running = false
      console.error('world-walk-server: step failed:', err)
    }
    state.generating = false
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks, total)))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length })
  res.end(body)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    try {
      sendJson(res, 500, { error: String(err?.message || err) })
    } catch (_) {}
  })
})

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/') {
    const body = Buffer.from(PAGE_HTML)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length })
    res.end(body)
    return
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    sendJson(res, 200, {
      loaded: state.loaded,
      running: state.running,
      generating: state.generating,
      block: state.block,
      lastStepMs: state.lastStepMs,
      error: state.error,
      keys: state.keys,
      newestFrame: nextFrameIndex - 1,
      oldestFrame: frames.length > 0 ? frames[0].index : -1
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/frame') {
    const i = Number(url.searchParams.get('i'))
    const frame = frames.find((f) => f.index === i)
    if (!frame) {
      sendJson(res, 404, { error: `frame ${i} not available` })
      return
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': frame.png.length })
    res.end(frame.png)
    return
  }

  if (req.method === 'POST' && url.pathname === '/keys') {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString('utf8') || '{}')
    for (const key of Object.keys(state.keys)) {
      if (typeof parsed[key] === 'boolean') state.keys[key] = parsed[key]
    }
    sendJson(res, 200, { keys: state.keys })
    return
  }

  if (req.method === 'POST' && url.pathname === '/walk') {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString('utf8') || '{}')
    if (parsed.running && !state.running) {
      if (!state.loaded) {
        sendJson(res, 409, { error: 'model still loading' })
        return
      }
      state.error = null
      state.running = true
      walkLoop()
    } else if (parsed.running === false) {
      state.running = false
    }
    sendJson(res, 200, { running: state.running })
    return
  }

  sendJson(res, 404, { error: `no route: ${req.method} ${url.pathname}` })
}

// ── page ─────────────────────────────────────────────────────────────────────
const PAGE_HTML = /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ABot-World walk — QVAC diffusion-cpp</title>
<style>
  body { margin: 0; background: #101418; color: #e8e8e8; font: 14px/1.45 system-ui, sans-serif; }
  .wrap { max-width: 900px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 18px; font-weight: 600; }
  .stage { position: relative; background: #000; border-radius: 8px; overflow: hidden; }
  .stage img { display: block; width: 100%; }
  .placeholder { aspect-ratio: 832 / 480; display: flex; align-items: center; justify-content: center; color: #8aa; }
  .hud { position: absolute; left: 12px; bottom: 12px; background: rgba(10,14,18,.75); border-radius: 8px; padding: 10px 12px; }
  .hud table { border-collapse: collapse; }
  .hud td { padding: 2px 6px; }
  .key { display: inline-block; min-width: 22px; text-align: center; padding: 3px 6px; margin: 1px;
         border: 1px solid #4a5a68; border-radius: 5px; background: #1c242c; font-weight: 600; }
  .key.held { background: #2e7d32; border-color: #58c25d; }
  .bar { display: flex; gap: 12px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  button { background: #2455a4; border: 0; color: #fff; padding: 8px 16px; border-radius: 6px; font-weight: 600; cursor: pointer; }
  button[disabled] { opacity: .45; cursor: default; }
  .status { color: #9ab; }
  .err { color: #ff7a7a; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ABot-World interactive walk</h1>
  <div class="stage">
    <img id="frame" hidden alt="walk frame">
    <div id="placeholder" class="placeholder">loading model…</div>
    <div class="hud">
      <table>
        <tr>
          <td>move</td>
          <td><span class="key" id="k-W">W</span><span class="key" id="k-A">A</span><span class="key" id="k-S">S</span><span class="key" id="k-D">D</span></td>
        </tr>
        <tr>
          <td>look</td>
          <td><span class="key" id="k-I">I</span><span class="key" id="k-J">J</span><span class="key" id="k-K">K</span><span class="key" id="k-L">L</span></td>
        </tr>
      </table>
    </div>
  </div>
  <div class="bar">
    <button id="toggle" disabled>Start walk</button>
    <span class="status" id="status">connecting…</span>
  </div>
  <p class="status">Hold <b>W/A/S/D</b> to move, <b>I/J/K/L</b> to look around. Keys apply to the
  <i>next generated block</i>; each block is a short burst of frames, so input latency equals block
  generation time (shown above). Click the page first so it receives key events.</p>
</div>
<script>
  const WALK_KEYS = ['W','A','S','D','I','J','K','L']
  const held = Object.fromEntries(WALK_KEYS.map(k => [k, false]))
  let running = false
  let shownFrame = -1
  const pending = []
  let playing = false

  function paintKeys(keys) {
    for (const k of WALK_KEYS) {
      document.getElementById('k-' + k).classList.toggle('held', !!keys[k])
    }
  }

  async function postKeys() {
    paintKeys(held)
    await fetch('/keys', { method: 'POST', body: JSON.stringify(held) }).catch(() => {})
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key.toUpperCase()
    if (WALK_KEYS.includes(k) && !held[k]) { held[k] = true; postKeys() }
  })
  window.addEventListener('keyup', (e) => {
    const k = e.key.toUpperCase()
    if (WALK_KEYS.includes(k) && held[k]) { held[k] = false; postKeys() }
  })
  window.addEventListener('blur', () => {
    let changed = false
    for (const k of WALK_KEYS) { if (held[k]) { held[k] = false; changed = true } }
    if (changed) postKeys()
  })

  document.getElementById('toggle').addEventListener('click', async () => {
    running = !running
    await fetch('/walk', { method: 'POST', body: JSON.stringify({ running }) }).catch(() => {})
    document.getElementById('toggle').textContent = running ? 'Stop walk' : 'Start walk'
  })

  async function playPending() {
    if (playing) return
    playing = true
    const img = document.getElementById('frame')
    const placeholder = document.getElementById('placeholder')
    while (pending.length > 0) {
      const i = pending.shift()
      try {
        const r = await fetch('/frame?i=' + i)
        if (!r.ok) continue
        const blob = await r.blob()
        const nextUrl = URL.createObjectURL(blob)
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url)
        img.src = nextUrl
        img.dataset.url = nextUrl
        img.hidden = false
        placeholder.hidden = true
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 1000 / 12)) // present at ~12 fps
    }
    playing = false
  }

  async function poll() {
    try {
      const s = await (await fetch('/state')).json()
      const btn = document.getElementById('toggle')
      btn.disabled = !s.loaded
      running = s.running
      btn.textContent = running ? 'Stop walk' : 'Start walk'
      const status = document.getElementById('status')
      if (s.error) {
        status.textContent = 'error: ' + s.error
        status.className = 'err'
      } else if (!s.loaded) {
        status.textContent = 'loading model…'
      } else {
        status.textContent =
          (s.generating ? 'generating block ' + s.block + '… ' : 'idle. ') +
          (s.lastStepMs ? 'last block: ' + (s.lastStepMs / 1000).toFixed(1) + 's' : '')
        document.getElementById('placeholder').textContent = 'press Start walk'
      }
      for (let i = Math.max(shownFrame + 1, s.oldestFrame); i <= s.newestFrame; i++) {
        pending.push(i)
        shownFrame = i
      }
      playPending()
    } catch (_) {}
    setTimeout(poll, 500)
  }
  poll()
</script>
</body>
</html>`

server.listen(PORT, HOST, () => {
  console.log(`world-walk-server: http://${HOST}:${PORT}/ (models: ${path.dirname(DIT_PATH)})`)
})

world
  .load()
  .then(() => {
    state.loaded = true
    console.log('world-walk-server: session ready — open the page and press "Start walk"')
  })
  .catch((err) => {
    state.error = String(err?.message || err)
    console.error('world-walk-server: model load failed:', err)
  })

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
 *   scene.safetensors                  (or set ABOT_SCENE; optional — without
 *                                       one, generate a world from the page)
 *
 * Optional env: HOST (127.0.0.1), PORT (8787), ABOT_THREADS, ABOT_SEED,
 * ABOT_BACKEND (e.g. "cpu", "cuda"), ABOT_KV_CACHE=1 (per-layer history KV
 * cache, the main speed knob - forwarded as the kvCache session param),
 * ABOT_PROF=1 (native timing logs), ABOT_JPEG_QUALITY (0/unset = PNG
 * frames; 1..100 = JPEG at that quality).
 *
 * Native scene creation (full world-generation workflow): when ABOT_SCENE
 * points at a file that does not exist yet AND ABOT_PROMPT + ABOT_IMAGE are
 * set, the server first builds the scene pack on-device (umT5-XXL prompt
 * encode + Wan2.2 VAE first-frame encode; models via ABOT_T5 / ABOT_VAE or
 * umt5-xxl-enc-q8_0.gguf / umt5-xxl-enc-f16.gguf / wan2.2_vae_f16.gguf in
 * ABOT_MODELS_DIR), writes it to ABOT_SCENE, then loads the walk session with
 * it. Optional ABOT_WIDTH / ABOT_HEIGHT (multiples of 32; default 832x480).
 * Without a scene and without creation inputs the server still starts and
 * waits for the page's "Generate a world" upload instead of failing the load.
 *
 * Endpoints: GET / (page), /state (telemetry), /stream (paced MJPEG push),
 * /frame?i=N (single frame + X-Frame-Ts/-Block headers); POST /keys, /walk,
 * /reset (full session reload -> block 0), /create-world?prompt= (body =
 * image bytes -> native scene pack -> session swap).
 *
 * Latency/smoothness design notes (measured on the RTX 5090 round):
 * - Frames MUST be pushed, not polled: per-frame HTTP fetch costs one tunnel
 *   round-trip each; whenever playback rate <= production rate (12 frames
 *   per ~1.5 s block = 8 fps), the client backlog grows without bound and the
 *   viewer watches ever-older video (observed 9 s key->photon; ~2.3 s is the
 *   generation-bound floor).
 * - Frames arrive as 12-frame BURSTS per block; the /stream pacer re-spaces
 *   them at the measured production rate (pace by time-since-last-emit - the
 *   queue drains between pushes, so queue length cannot pace). First frame of
 *   a fresh block is never delayed, so pacing adds no key latency.
 * - Client backpressure: drop frames for a slow client (writableNeedDrain via
 *   write() return + 'drain'), never queue them.
 * - bare-http1 quirks (cost a debug round each): res.write(data, callback)
 *   never invokes the callback, and a GET's REQUEST stream emits 'close'
 *   immediately after its empty body - track connection lifetime on the
 *   RESPONSE stream only.
 * - World restart is a full session reload (~15 s): the C API has no
 *   lightweight reset; a native sd_abot_session_reset (clear history + KV
 *   cache + RNG, keep weights) would make it near-instant. Engine wishlist.
 * - Image input: stb decode (magic bytes, extension ignored; JPEG/PNG only -
 *   no WebP/AVIF/HEIC), EXIF rotation not honored, cover-crop to 832x480; an
 *   image is REQUIRED - the distilled ci2v checkpoint cannot bootstrap a
 *   world from text alone (validated: degenerate output).
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

function findModelFile(envKey, fallbackNames) {
  if (process.env[envKey]) return process.env[envKey]
  const dir = process.env.ABOT_MODELS_DIR
  if (!dir) return null
  for (const name of fallbackNames) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function resolveModelFile(envKey, fallbackNames) {
  const found = findModelFile(envKey, fallbackNames)
  if (found) return found
  console.error(
    `world-walk-server: none of ${fallbackNames.join(', ')} found — ` +
      `set ABOT_MODELS_DIR or ${envKey}`
  )
  process.exit(1)
}

// Scene-creation encoders are only needed when a world is actually created,
// so a walk-only setup (dit + taehv + prebuilt scene pack) must not require
// them at startup — resolve lazily and throw (not exit) when missing.
function requireSceneEncoder(envKey, fallbackNames) {
  const found = findModelFile(envKey, fallbackNames)
  if (found) return found
  throw new Error(
    `none of ${fallbackNames.join(', ')} found — scene creation needs it; ` +
      `set ${envKey} or add it to ABOT_MODELS_DIR`
  )
}

const DIT_PATH = resolveModelFile('ABOT_DIT', [
  'abot-world-0-5b-lf-dit-q8_0.gguf',
  'abot-world-0-5b-lf-dit-f16.gguf'
])
const TAEHV_PATH = resolveModelFile('ABOT_TAEHV', ['taew2_2_f16.gguf'])
// The scene pack may not exist yet (native creation writes it at startup),
// so resolve its PATH without requiring the file to be present.
const SCENE_PATH =
  process.env.ABOT_SCENE ||
  path.join(process.env.ABOT_MODELS_DIR || '.', 'scene.safetensors')
// Scene-creation encoder names (resolved lazily by requireSceneEncoder).
// Q8 first: that is the published P2P-registry set; F16 covers local converts.
const T5_NAMES = ['umt5-xxl-enc-q8_0.gguf', 'umt5-xxl-enc-f16.gguf']
const VAE_NAMES = ['wan2.2_vae_f16.gguf']
// The active scene can be swapped at runtime by /create-world
let currentScenePath = SCENE_PATH

function makeWorld() {
  return new WorldStableDiffusion({
    files: { model: DIT_PATH, taehv: TAEHV_PATH, scene: currentScenePath },
    config: {
      threads: process.env.ABOT_THREADS || undefined,
      seed: process.env.ABOT_SEED || undefined,
      backend: process.env.ABOT_BACKEND || undefined,
      // 0/unset = lossless PNG frames; 1..100 = JPEG at that quality (much
      // smaller frames, so remote/tunneled browsers stream far less data).
      // Number(): frameJpegQuality is validated with Number.isInteger, so the
      // raw env string is rejected (threads/seed/backend reach the native
      // string parser instead and need no coercion here).
      frameJpegQuality: process.env.ABOT_JPEG_QUALITY
        ? Number(process.env.ABOT_JPEG_QUALITY)
        : undefined,
      // The engine takes these as session params now (the native library no
      // longer reads ABOT_* environment variables); the env names stay as
      // launcher conveniences and become explicit config here.
      kvCache: process.env.ABOT_KV_CACHE === '1' || undefined,
      profile: process.env.ABOT_PROF === '1' || undefined
    },
    opts: { stats: true }
  })
}

let world = makeWorld()

// ── walk state ───────────────────────────────────────────────────────────────
const state = {
  loaded: false,
  running: false,
  generating: false,
  resetting: false,
  creating: false,
  noScene: false,
  block: 0,
  lastStepMs: 0,
  error: null,
  keys: { W: false, A: false, S: false, D: false, I: false, J: false, K: false, L: false }
}
const frames = [] // ring of { index, png:Buffer, ts, block }
let nextFrameIndex = 0

// MJPEG push stream: one persistent connection per viewer, always fed the
// NEWEST frame; when the client socket is backed up the frame is dropped for
// that client (inherently live - the backlog can never grow).
const streamClients = new Set()
const STREAM_BOUNDARY = 'abotframe'

function broadcastFrame(entry) {
  if (streamClients.size === 0) return
  // frames are PNG or JPEG depending on frameJpegQuality - label each part
  // by its magic bytes (same sniff as /frame)
  const isJpeg = entry.png.length > 1 && entry.png[0] === 0xff && entry.png[1] === 0xd8
  const head = Buffer.from(
    `--${STREAM_BOUNDARY}\r\n` +
      `Content-Type: ${isJpeg ? 'image/jpeg' : 'image/png'}\r\n` +
      `Content-Length: ${entry.png.length}\r\n` +
      `X-Frame-Index: ${entry.index}\r\n` +
      `X-Frame-Block: ${entry.block}\r\n\r\n`
  )
  for (const res of streamClients) {
    try {
      if (res.destroyed) {
        streamClients.delete(res)
        continue
      }
      // drop-on-backpressure: while the client's socket buffer is full, skip
      // frames for it (it stays live instead of accumulating a backlog)
      if (res._abotWaitDrain) continue
      const okHead = res.write(head)
      const okBody = res.write(entry.png)
      const okTail = res.write('\r\n')
      if (!(okHead && okBody && okTail)) {
        res._abotWaitDrain = true
        res.once('drain', () => { res._abotWaitDrain = false })
      }
    } catch (_) {
      streamClients.delete(res)
    }
  }
}

// Stream pacer: blocks arrive as 12-frame bursts every ~1.5 s; broadcasting
// them raw makes playback jerky (fast-forward burst, then freeze). Release
// frames evenly at the measured production rate instead - the first frame of
// a fresh block still goes out immediately (no added key latency); only the
// tail of each burst waits. A cap keeps the stream live if a client or the
// generator stalls.
const pacedQueue = []
const PACED_QUEUE_CAP = 18 // ~1.5 blocks; beyond this, drop oldest (stay live)
let pacerRunning = false

function paceInterval() {
  const avg = blockMsLog.length
    ? blockMsLog.reduce((a, b) => a + b, 0) / blockMsLog.length
    : 1500
  return Math.min(Math.max(avg / 12, 60), 200)
}

let lastEmitTs = 0

function startPacer() {
  if (pacerRunning) return
  pacerRunning = true
  const tick = () => {
    if (pacedQueue.length === 0) {
      pacerRunning = false
      return
    }
    // pace by TIME since the last emitted frame (the queue often drains to
    // empty between pushes, so queue length alone cannot pace a burst)
    const now = Date.now()
    const interval = paceInterval()
    const waitMs = lastEmitTs + interval - now
    if (waitMs > 5) {
      setTimeout(tick, waitMs)
      return
    }
    lastEmitTs = now
    broadcastFrame(pacedQueue.shift())
    setTimeout(tick, interval)
  }
  tick()
}

function pushFrame(png) {
  const entry = { index: nextFrameIndex++, png, ts: Date.now(), block: state.block }
  frames.push(entry)
  while (frames.length > FRAME_RING_SIZE) frames.shift()
  pacedQueue.push(entry)
  if (pacedQueue.length > PACED_QUEUE_CAP) {
    pacedQueue.splice(0, pacedQueue.length - PACED_QUEUE_CAP)
  }
  startPacer()
}

// ── latency telemetry ────────────────────────────────────────────────────────
// blockMsLog: recent per-block generation times; keyApply: when a key change
// was actually consumed by a block (server-side share of key->photon latency).
const blockMsLog = []
let lastKeyChangeTs = 0
let prevBlockMask = -1
const telemetry = { keyApply: null }

function currentMask() {
  let m = 0
  const order = ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L']
  for (let b = 0; b < order.length; b++) if (state.keys[order[b]]) m |= 1 << b
  return m
}

async function walkLoop() {
  while (state.running) {
    state.generating = true
    const t0 = Date.now()
    const mask = currentMask()
    if (mask !== prevBlockMask) {
      telemetry.keyApply = {
        block: state.block,                       // first block generated with the new keys
        keyTs: lastKeyChangeTs || t0,
        applyTs: t0,
        waitMs: lastKeyChangeTs ? t0 - lastKeyChangeTs : 0
      }
      prevBlockMask = mask
    }
    try {
      const response = await world.step({ ...state.keys })
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) pushFrame(Buffer.from(data))
        })
        .await()
      state.block++
      state.lastStepMs = Date.now() - t0
      blockMsLog.push(state.lastStepMs)
      if (blockMsLog.length > 20) blockMsLog.shift()
    } catch (err) {
      state.error = String(err?.message || err)
      state.running = false
      console.error('world-walk-server: step failed:', err)
    }
    state.generating = false
  }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > maxBytes) {
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
    const avgBlockMs = blockMsLog.length
      ? blockMsLog.reduce((a, b) => a + b, 0) / blockMsLog.length
      : 0
    sendJson(res, 200, {
      loaded: state.loaded,
      running: state.running,
      generating: state.generating,
      resetting: state.resetting,
      creating: state.creating,
      noScene: state.noScene,
      block: state.block,
      lastStepMs: state.lastStepMs,
      error: state.error,
      keys: state.keys,
      newestFrame: nextFrameIndex - 1,
      oldestFrame: frames.length > 0 ? frames[0].index : -1,
      // latency telemetry
      serverNow: Date.now(),
      avgBlockMs,
      genFps: avgBlockMs > 0 ? 12000 / avgBlockMs : 0,
      keyApply: telemetry.keyApply,
      streamBuffer: pacedQueue.length,
      streamPaceMs: paceInterval()
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${STREAM_BOUNDARY}`,
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    streamClients.add(res)
    // NOTE: no req.on('close') here - in bare-http1 the REQUEST stream closes
    // as soon as its (empty GET) body is consumed, which would evict the
    // client immediately. The response stream tracks the connection lifetime.
    res.on('close', () => streamClients.delete(res))
    res.on('error', () => streamClients.delete(res))
    // send the newest frame immediately so the viewer isn't blank
    if (frames.length > 0) broadcastFrame(frames[frames.length - 1])
    return
  }

  if (req.method === 'GET' && url.pathname === '/frame') {
    const i = Number(url.searchParams.get('i'))
    const frame = frames.find((f) => f.index === i)
    if (!frame) {
      sendJson(res, 404, { error: `frame ${i} not available` })
      return
    }
    // frames are PNG (\x89PNG) or JPEG (\xff\xd8) depending on frameJpegQuality
    const isJpeg = frame.png.length > 1 && frame.png[0] === 0xff && frame.png[1] === 0xd8
    res.writeHead(200, {
      'Content-Type': isJpeg ? 'image/jpeg' : 'image/png',
      'Content-Length': frame.png.length,
      'X-Frame-Ts': String(frame.ts),      // server time the frame became available
      'X-Frame-Block': String(frame.block) // walk block that produced it
    })
    res.end(frame.png)
    return
  }

  if (req.method === 'POST' && url.pathname === '/keys') {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString('utf8') || '{}')
    const before = currentMask()
    for (const key of Object.keys(state.keys)) {
      if (typeof parsed[key] === 'boolean') state.keys[key] = parsed[key]
    }
    if (currentMask() !== before) lastKeyChangeTs = Date.now()
    sendJson(res, 200, { keys: state.keys, ts: lastKeyChangeTs })
    return
  }

  if (req.method === 'POST' && url.pathname === '/create-world') {
    // World generation from an image: body = raw image bytes (PNG/JPEG),
    // optional ?prompt= query (defaults to the reference's minimal
    // "| unknown |"). Creates the scene pack natively (umT5 + Wan2.2 VAE),
    // swaps the session onto it and starts fresh at block 0.
    if (state.resetting || state.creating) {
      sendJson(res, 409, { error: 'busy: world restart/creation in progress' })
      return
    }
    const image = await readBody(req, 25 * 1024 * 1024)
    if (image.length < 100) {
      sendJson(res, 400, { error: 'body must be the image bytes (PNG or JPEG)' })
      return
    }
    let prompt = url.searchParams.get('prompt') || ''
    prompt = prompt.trim() || '| unknown |'
    if (!prompt.startsWith('| unknown |')) prompt = '| unknown | ' + prompt
    state.creating = true
    state.running = false
    state.loaded = false
    const prevScenePath = currentScenePath
    try {
      while (state.generating) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      try {
        await world.unload()
      } catch (_) {}
      const scenePath = path.join(
        path.dirname(currentScenePath),
        `scene_upload_${Date.now()}.safetensors`
      )
      console.log(`world-walk-server: creating world from uploaded image (${image.length} bytes), prompt "${prompt.slice(0, 60)}"`)
      const t0 = Date.now()
      currentScenePath = scenePath
      world = makeWorld()
      const response = await world.createScene({
        prompt,
        image: new Uint8Array(image),
        t5: requireSceneEncoder('ABOT_T5', T5_NAMES),
        vae: requireSceneEncoder('ABOT_VAE', VAE_NAMES),
        output: scenePath,
        width: Number(process.env.ABOT_WIDTH || 832),
        height: Number(process.env.ABOT_HEIGHT || 480)
      })
      await response.onUpdate(() => {}).await()
      console.log(`world-walk-server: scene written to ${scenePath} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      await world.load()
      state.block = 0
      state.lastStepMs = 0
      state.error = null
      blockMsLog.length = 0
      telemetry.keyApply = null
      prevBlockMask = -1
      lastKeyChangeTs = 0
      pacedQueue.length = 0
      state.loaded = true
      state.noScene = false
      // uploaded packs are throwaway once replaced - drop the previous one so
      // repeated generations don't accumulate ~10 MB files (never touches a
      // user-provided scene path)
      if (path.basename(prevScenePath).startsWith('scene_upload_')) {
        try {
          fs.unlinkSync(prevScenePath)
        } catch (_) {}
      }
      console.log('world-walk-server: new world ready (block 0)')
      sendJson(res, 200, { ok: true, scene: scenePath, prompt })
    } catch (err) {
      state.error = String(err?.message || err)
      // fall back to the previous world so walking/reset still work; without
      // this the server would be left pointing at a scene pack that was never
      // written
      currentScenePath = prevScenePath
      try {
        await world.unload()
      } catch (_) {}
      world = makeWorld()
      if (fs.existsSync(prevScenePath)) {
        try {
          await world.load()
          state.block = 0
          state.loaded = true
        } catch (_) {}
      } else {
        state.noScene = true
      }
      sendJson(res, 500, { error: state.error })
    } finally {
      state.creating = false
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    // full world restart: reload the session on the original scene (block 0).
    // Heavy (~15 s, reloads DiT + taehv + scene); a native lightweight session
    // reset in the engine would make this instant - future improvement.
    if (state.resetting || state.creating) {
      sendJson(res, 409, { error: 'busy: world restart/creation in progress' })
      return
    }
    state.resetting = true
    state.running = false
    state.loaded = false
    try {
      while (state.generating) {
        await new Promise((r) => setTimeout(r, 100))
      }
      try {
        await world.unload()
      } catch (_) {}
      world = makeWorld()
      await world.load()
      state.block = 0
      state.lastStepMs = 0
      state.error = null
      blockMsLog.length = 0
      telemetry.keyApply = null
      prevBlockMask = -1
      lastKeyChangeTs = 0
      pacedQueue.length = 0
      state.loaded = true
      console.log('world-walk-server: world restarted (fresh session, block 0)')
      sendJson(res, 200, { ok: true })
    } catch (err) {
      state.error = String(err?.message || err)
      sendJson(res, 500, { error: state.error })
    } finally {
      state.resetting = false
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/walk') {
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString('utf8') || '{}')
    if (parsed.running && !state.running) {
      if (!state.loaded) {
        sendJson(res, 409, {
          error: state.noScene
            ? 'no world yet — generate one from an image first'
            : 'model still loading'
        })
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
  .card { background: #141a20; border: 1px solid #26313c; border-radius: 10px; padding: 14px 16px; margin: 14px 0; }
  .cardtitle { font-weight: 600; color: #cfe0ee; margin-bottom: 4px; }
  .stage { position: relative; background: #000; border-radius: 8px; overflow: hidden; }
  .stage img { display: block; width: 100%; }
  .placeholder { padding: 18px 0; display: flex; align-items: center; justify-content: center; color: #8aa; }
  .placeholder[hidden] { display: none !important; }
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
  <h1>ABot-World — generate a world and walk it</h1>

  <div class="card">
    <div class="cardtitle">1 · Generate a world</div>
    <p class="status" style="margin:4px 0 10px">
      The world is built from a <b>starting image</b> (required — this model cannot
      imagine a world from text alone) plus an optional short <b>text description</b>
      that steers the style and content. Generation runs on this machine in
      ~20&nbsp;seconds. Skip this step to walk the world that is already loaded.
    </p>
    <div class="bar" style="margin:0">
      <input type="file" id="worldimage" accept="image/png,image/jpeg" class="status">
      <input type="text" id="worldprompt" placeholder="optional: describe the scene (e.g. rainy neon street)" size="40"
             style="background:#1c242c;border:1px solid #4a5a68;border-radius:6px;color:#e8e8e8;padding:7px 10px;">
      <button id="createworld" disabled>Generate world</button>
    </div>
  </div>

  <div class="card">
    <div class="cardtitle">2 · Walk it</div>
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
      <button id="reset" disabled>Restart world</button>
      <label class="status" title="uncheck for per-frame fetch with full latency telemetry"><input type="checkbox" id="streammode" checked> live stream</label>
      <span class="status" id="status">connecting…</span>
    </div>
    <div class="bar status" id="stats" style="margin:4px 0 0">stats: waiting for walk…</div>
    <p class="status" style="margin-top:10px">Hold <b>W/A/S/D</b> to move, <b>I/J/K/L</b> to look around. Keys apply to the
    <i>next generated block</i> (~1.5&nbsp;s), so reactions take a moment. Click the page first so it
    receives key events. If the world degrades after long walks, press <b>Restart world</b>.</p>
  </div>
</div>
<script>
  const WALK_KEYS = ['W','A','S','D','I','J','K','L']
  const held = Object.fromEntries(WALK_KEYS.map(k => [k, false]))
  let running = false
  let shownFrame = -1
  const pending = []
  let playing = false

  // latency telemetry (client side)
  let clockOffset = 0            // serverNow - Date.now(), refreshed each poll
  let genFps = 0
  let lastBlockMs = 0
  let newestKnown = -1
  let lastFetchMs = 0
  const paintTimes = []          // rolling timestamps of painted frames -> play fps
  let shownBlock = -1
  let shownAgeMs = 0
  let keyWaitMs = -1             // server: key change -> consumed by next block
  let streamBuffer = 0
  let streamPaceMs = 0
  // measured key->photon (measure mode): tied to a specific key press
  let press = null               // { t: performance.now(), clientTs: Date.now() }
  let pressApplyBlock = -1       // block that consumed THIS press (from server)
  let keyPhotonMs = 0

  function paintKeys(keys) {
    for (const k of WALK_KEYS) {
      document.getElementById('k-' + k).classList.toggle('held', !!keys[k])
    }
  }

  async function postKeys(isPress) {
    paintKeys(held)
    if (isPress) {
      press = { t: performance.now(), clientTs: Date.now() }
      pressApplyBlock = -1
    }
    await fetch('/keys', { method: 'POST', body: JSON.stringify(held) }).catch(() => {})
  }

  function fmtStats() {
    const streaming = document.getElementById('streammode').checked
    const playFps = paintTimes.length > 1
      ? ((paintTimes.length - 1) * 1000 / (paintTimes[paintTimes.length - 1] - paintTimes[0]))
      : 0
    let out = 'gen ' + genFps.toFixed(1) + ' fps · block ' + (lastBlockMs / 1000).toFixed(2) + 's'
    if (streaming) {
      out += ' · mode: paced stream (' + streamPaceMs.toFixed(0) + 'ms/frame, buf ' + streamBuffer + ')'
      if (keyWaitMs >= 0) {
        out += ' · key→block wait ' + (keyWaitMs / 1000).toFixed(2) + 's' +
               ' · est key→photon ~' + ((keyWaitMs + lastBlockMs) / 1000 + 0.2).toFixed(1) + 's'
      }
    } else {
      const lag = Math.max(newestKnown - shownFrame, 0)
      out += ' · play ' + playFps.toFixed(1) + ' fps · lag ' + lag + ' frames' +
        ' · frame age ' + (shownAgeMs / 1000).toFixed(1) + 's' +
        ' · fetch ' + lastFetchMs.toFixed(0) + 'ms' +
        (keyPhotonMs > 0 ? ' · key→photon ' + (keyPhotonMs / 1000).toFixed(1) + 's' : '')
    }
    return out
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key.toUpperCase()
    if (WALK_KEYS.includes(k) && !held[k]) { held[k] = true; postKeys(true) }
  })
  window.addEventListener('keyup', (e) => {
    const k = e.key.toUpperCase()
    if (WALK_KEYS.includes(k) && held[k]) { held[k] = false; postKeys(false) }
  })
  window.addEventListener('blur', () => {
    let changed = false
    for (const k of WALK_KEYS) { if (held[k]) { held[k] = false; changed = true } }
    if (changed) postKeys(false)
  })

  // ── display modes ──────────────────────────────────────────────────────────
  // stream mode: the <img> is fed by the server's MJPEG push stream; no
  // per-frame round trips, the server drops frames if the pipe is behind.
  // measure mode: per-frame fetch player with full client-side telemetry.
  function applyMode() {
    const img = document.getElementById('frame')
    const streaming = document.getElementById('streammode').checked
    if (streaming) {
      pending.length = 0
      if (img.dataset.url) { URL.revokeObjectURL(img.dataset.url); delete img.dataset.url }
      img.src = '/stream'
      img.hidden = false
      document.getElementById('placeholder').hidden = true
    } else {
      img.src = ''
      shownFrame = Math.max(newestKnown - 1, -1) // start near live
    }
  }
  document.getElementById('streammode').addEventListener('change', applyMode)
  window.addEventListener('load', applyMode)

  document.getElementById('toggle').addEventListener('click', async () => {
    running = !running
    await fetch('/walk', { method: 'POST', body: JSON.stringify({ running }) }).catch(() => {})
    document.getElementById('toggle').textContent = running ? 'Stop walk' : 'Start walk'
  })

  document.getElementById('reset').addEventListener('click', async () => {
    const btn = document.getElementById('reset')
    btn.disabled = true
    btn.textContent = 'Restarting…'
    document.getElementById('status').textContent = 'restarting world (reloads the session, ~15s)…'
    try {
      await fetch('/reset', { method: 'POST', body: '{}' })
    } catch (_) {}
    btn.textContent = 'Restart world'
  })

  document.getElementById('worldimage').addEventListener('change', () => {
    const f = document.getElementById('worldimage').files[0]
    document.getElementById('createworld').disabled = !f
  })

  document.getElementById('createworld').addEventListener('click', async () => {
    const file = document.getElementById('worldimage').files[0]
    if (!file) return
    const btn = document.getElementById('createworld')
    btn.disabled = true
    btn.textContent = 'Generating…'
    document.getElementById('status').textContent = 'generating world from image (~20s)…'
    try {
      const prompt = document.getElementById('worldprompt').value || ''
      const r = await fetch('/create-world?prompt=' + encodeURIComponent(prompt), {
        method: 'POST',
        body: file
      })
      const out = await r.json()
      document.getElementById('status').textContent = out.error
        ? 'error: ' + out.error
        : 'world ready — press Start walk'
    } catch (_) {}
    btn.textContent = 'Generate world'
  })

  async function playPending() {
    if (playing) return
    if (document.getElementById('streammode').checked) return // stream mode: <img> is server-fed
    playing = true
    const img = document.getElementById('frame')
    const placeholder = document.getElementById('placeholder')
    while (pending.length > 0 && !document.getElementById('streammode').checked) {
      const i = pending.shift()
      try {
        const t0 = performance.now()
        const r = await fetch('/frame?i=' + i)
        lastFetchMs = performance.now() - t0
        if (!r.ok) continue
        const frameTs = Number(r.headers.get('X-Frame-Ts') || 0)
        const frameBlock = Number(r.headers.get('X-Frame-Block') || -1)
        const blob = await r.blob()
        const nextUrl = URL.createObjectURL(blob)
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url)
        img.src = nextUrl
        img.dataset.url = nextUrl
        img.hidden = false
        placeholder.hidden = true
        shownFrame = i
        shownBlock = frameBlock
        shownAgeMs = frameTs > 0 ? (Date.now() + clockOffset) - frameTs : 0
        const now = performance.now()
        paintTimes.push(now)
        while (paintTimes.length > 36) paintTimes.shift()
        // measured key->photon: first painted frame of the block that consumed
        // THIS key press (pressApplyBlock is validated against the press time)
        if (press !== null && pressApplyBlock >= 0 && frameBlock >= pressApplyBlock) {
          keyPhotonMs = now - press.t
          press = null
          pressApplyBlock = -1
        }
        document.getElementById('stats').textContent = fmtStats()
      } catch (_) {}
      // pace presentation only when caught up; drain any backlog at full speed
      if (pending.length <= 2) {
        await new Promise((r) => setTimeout(r, 1000 / 12)) // present at ~12 fps
      }
    }
    playing = false
  }

  async function poll() {
    try {
      const s = await (await fetch('/state')).json()
      const btn = document.getElementById('toggle')
      btn.disabled = !s.loaded
      document.getElementById('reset').disabled = !s.loaded || s.resetting
      running = s.running
      btn.textContent = running ? 'Stop walk' : 'Start walk'
      const status = document.getElementById('status')
      if (s.error) {
        status.textContent = 'error: ' + s.error
        status.className = 'err'
      } else if (s.creating) {
        status.textContent = 'creating world from image…'
      } else if (s.resetting) {
        status.textContent = 'restarting world (fresh session)…'
      } else if (!s.loaded && s.noScene) {
        status.textContent = 'no world yet — generate one from an image (card 1)'
        document.getElementById('placeholder').textContent = 'no world yet — generate one above'
      } else if (!s.loaded) {
        status.textContent = 'loading model…'
      } else if (s.running) {
        status.textContent = 'walking — block ' + s.block +
          (s.lastStepMs ? ' (' + (s.lastStepMs / 1000).toFixed(1) + 's/block)' : '')
      } else {
        status.textContent = s.block === 0
          ? 'world ready — press Start walk'
          : 'paused at block ' + s.block + ' — press Start walk to continue'
        document.getElementById('placeholder').textContent = 'world ready — press Start walk'
      }
      const cw = document.getElementById('createworld')
      cw.disabled = s.creating || s.resetting || !document.getElementById('worldimage').files[0]
      clockOffset = (s.serverNow || Date.now()) - Date.now()
      genFps = s.genFps || 0
      lastBlockMs = s.lastStepMs || 0
      streamBuffer = s.streamBuffer || 0
      streamPaceMs = s.streamPaceMs || 0
      newestKnown = s.newestFrame
      if (s.keyApply) {
        keyWaitMs = s.keyApply.waitMs
        // bind the server's key-consumption record to OUR outstanding press:
        // accept it only if the server saw the key change at/after our press
        if (press !== null && s.keyApply.keyTs >= press.clientTs + clockOffset - 1500) {
          pressApplyBlock = s.keyApply.block
        }
      }
      if (!document.getElementById('streammode').checked) {
        const enqueueFrom = Math.max(shownFrame + 1, s.oldestFrame)
        for (let i = enqueueFrom; i <= s.newestFrame; i++) {
          if (!pending.includes(i)) pending.push(i)
        }
        playPending()
      }
      document.getElementById('stats').textContent = fmtStats()
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

// Native scene creation at startup: when the scene pack does not exist yet
// and ABOT_PROMPT + ABOT_IMAGE (+ ABOT_T5 + ABOT_VAE model paths) are set,
// build it first — umT5 encodes the prompt, the Wan2.2 VAE encodes the image —
// then load the session with the freshly written pack. This is the full
// on-device world-generation workflow (no offline PyTorch extraction).
async function createSceneIfRequested() {
  if (fs.existsSync(SCENE_PATH)) return
  const prompt = process.env.ABOT_PROMPT
  const imagePath = process.env.ABOT_IMAGE
  if (!prompt || !imagePath) {
    return // no scene and no creation inputs -> load() will fail with a clear error
  }
  const t5 = requireSceneEncoder('ABOT_T5', T5_NAMES)
  const vae = requireSceneEncoder('ABOT_VAE', VAE_NAMES)
  console.log(`world-walk-server: creating scene from "${prompt.slice(0, 60)}..." + ${imagePath}`)
  const t0 = Date.now()
  const response = await world.createScene({
    prompt,
    image: new Uint8Array(fs.readFileSync(imagePath)),
    t5,
    vae,
    output: SCENE_PATH,
    width: Number(process.env.ABOT_WIDTH || 832),
    height: Number(process.env.ABOT_HEIGHT || 480)
  })
  await response.onUpdate(() => {}).await()
  console.log(`world-walk-server: scene written to ${SCENE_PATH} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

async function startup() {
  await createSceneIfRequested()
  if (!fs.existsSync(currentScenePath)) {
    // No scene pack and no ABOT_PROMPT/ABOT_IMAGE to create one: not an error.
    // Wait for the page's "Generate a world" upload instead of failing load().
    state.noScene = true
    console.log(
      'world-walk-server: no scene pack yet — open the page and use ' +
        '"Generate a world" (or set ABOT_PROMPT + ABOT_IMAGE to create one at startup)'
    )
    return
  }
  await world.load()
  state.loaded = true
  console.log('world-walk-server: session ready — open the page and press "Start walk"')
}

startup().catch((err) => {
  state.error = String(err?.message || err)
  console.error('world-walk-server: startup failed:', err)
})

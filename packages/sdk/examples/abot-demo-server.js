/* ABot-World SDK demo server: an interactive browser walk over a paced MJPEG
 * stream, driven end to end by the QVAC SDK.
 *
 * Upload-first flow:
 *   loadModel(mode:'world')  — at startup (session defers until a scene exists)
 *   worldCreateScene         — when the browser uploads a photo (+ optional prompt)
 *   worldStep loop           — idle blocks keep the stream live; held browser
 *                              keys (WASD/IJKL) steer. No auto-walk tape.
 * Uploading another photo swaps to a fresh world (clean unload -> reload ->
 * scene create; a resident session never re-reads a rewritten pack).
 *
 * Runs under the bare runtime via the SDK example bootstrap:
 *   bare ./scripts/bare-bootstrap.js examples/abot-demo-server.js
 * (plain JS, not TS: loaded directly, no build step; bare-http1 instead of
 * node:http because the bare import map has no 'http' entry)
 */
import { loadModel, unloadModel, worldCreateScene, worldStep } from '@qvac/sdk'
import fs from 'fs'
import http from 'bare-http1'
import path from 'path'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8790)
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const scenePack = path.resolve(process.env.ABOT_WORKDIR || '.', 'abot-demo-scene.safetensors')

const held = new Set()
const state = {
  block: 0,
  lastMs: 0,
  keys: [],
  phase: 'loading model',
  hasWorld: false,
  paceMs: 0,
  buffer: 0,
  prompt: ''
}
const clients = new Set()
const BOUNDARY = 'abotframe'
let latest = null

let modelId = null
let walking = false // step loop active
let stepping = false // a worldStep is in flight
let creating = false // create-world in progress
let stopRequested = false

function broadcast(frame) {
  latest = frame
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`
  )
  for (const res of clients) {
    if (res.destroyed) {
      clients.delete(res)
      continue
    }
    res.write(head)
    res.write(frame)
    res.write(Buffer.from('\r\n'))
  }
}

// ── stream pacer ─────────────────────────────────────────────────────────────
// worldStep() hands back a whole block (12 frames) at once, so generation and
// playback must not share one loop: emitting the burst inline and only then
// generating the next block leaves the viewer with ~2 s of frames followed by
// ~2 s of frozen image. Generation therefore runs flat out and pushes frames
// here, while this timer releases them one at a time at the measured
// production rate. A cap drops the oldest frames so a stalled client or a slow
// block can never turn the stream into a growing delay.
const pacedQueue = []
const PACED_QUEUE_CAP = 18 // ~1.5 blocks
const blockMsLog = []
let pacerRunning = false
let lastEmitTs = 0

function paceInterval() {
  const avg = blockMsLog.length ? blockMsLog.reduce((a, b) => a + b, 0) / blockMsLog.length : 2200
  const framesPerBlock = 12
  return Math.min(Math.max(avg / framesPerBlock, 60), 250)
}

function startPacer() {
  if (pacerRunning) return
  pacerRunning = true
  const tick = () => {
    if (pacedQueue.length === 0) {
      pacerRunning = false
      return
    }
    // pace on time since the last emitted frame: the queue drains to empty
    // between block pushes, so queue depth alone cannot pace a burst
    const now = Date.now()
    const interval = paceInterval()
    const waitMs = lastEmitTs + interval - now
    if (waitMs > 5) {
      setTimeout(tick, waitMs)
      return
    }
    lastEmitTs = now
    broadcast(pacedQueue.shift())
    state.buffer = pacedQueue.length
    state.paceMs = Math.round(interval)
    setTimeout(tick, interval)
  }
  tick()
}

function pushFrames(frames) {
  for (const f of frames) pacedQueue.push(Buffer.from(f))
  if (pacedQueue.length > PACED_QUEUE_CAP) {
    pacedQueue.splice(0, pacedQueue.length - PACED_QUEUE_CAP)
  }
  state.buffer = pacedQueue.length
  startPacer()
}

async function loadWorldModel() {
  if (fs.existsSync(scenePack)) fs.unlinkSync(scenePack)
  console.log('▸ loadModel (mode: world) via @qvac/sdk ...')
  const id = await loadModel({
    modelSrc: process.env.ABOT_DIT,
    modelType: 'sdcpp-generation',
    modelConfig: {
      mode: 'world',
      taehvModelSrc: process.env.ABOT_TAEHV,
      t5XxlModelSrc: process.env.ABOT_T5,
      vaeModelSrc: process.env.ABOT_VAE,
      world: { scenePack, seed: 42, kv_cache: true, frame_jpeg_quality: 85 }
    }
  })
  console.log(`▸ model loaded: ${id}`)
  return id
}

async function stepLoop() {
  walking = true
  while (walking && !stopRequested) {
    const keys = [...held]
    state.keys = keys
    const t0 = Date.now()
    stepping = true
    try {
      const { frames } = worldStep({ modelId, keys })
      const blockFrames = await frames
      state.block++
      state.lastMs = Date.now() - t0
      blockMsLog.push(state.lastMs)
      if (blockMsLog.length > 8) blockMsLog.shift()
      console.log(`▸ block ${state.block} · ${state.lastMs} ms · [${keys.join('+') || 'idle'}]`)
      // hand the burst to the pacer and immediately generate the next block:
      // playback and generation overlap, so the stream never freezes
      pushFrames(blockFrames)
    } catch (e) {
      state.phase = 'walk error: ' + (e && e.message ? e.message : e)
      console.error('✖ worldStep failed:', e)
      walking = false
    } finally {
      stepping = false
    }
  }
  if (stopRequested) {
    console.log('▸ unloading model ...')
    try {
      await unloadModel({ modelId, clearStorage: false })
    } catch {}
    process.exit(0)
  }
}

async function createWorld(imageBytes, prompt) {
  creating = true
  try {
    // pause the walk and drain any in-flight step
    walking = false
    while (stepping) await new Promise((r) => setTimeout(r, 100))
    // drop queued frames of the outgoing world so the new one starts clean
    pacedQueue.length = 0
    blockMsLog.length = 0
    state.buffer = 0

    // a resident session keeps the scene it loaded — swap worlds on a clean
    // unload -> load cycle so the new pack is what the session reads
    if (state.hasWorld) {
      state.phase = 'reloading session'
      console.log('▸ unloadModel (fresh world requested) ...')
      await unloadModel({ modelId, clearStorage: false })
      modelId = await loadWorldModel()
      state.block = 0
      state.hasWorld = false
    }

    state.phase = 'creating world'
    console.log(
      `▸ worldCreateScene (${imageBytes.length} bytes${prompt ? `, "${prompt.slice(0, 50)}"` : ''})`
    )
    const effectivePrompt = prompt || 'a realistic scene with a navigable path'
    state.prompt = effectivePrompt
    const scene = worldCreateScene({
      modelId,
      prompt: effectivePrompt,
      image: new Uint8Array(imageBytes)
    })
    const sStats = await scene.stats
    console.log(`▸ scene pack written in ${sStats?.sceneCreateMs} ms`)

    state.hasWorld = true
    state.phase = 'walking'
    stepLoop()
    return null
  } catch (e) {
    state.phase = 'create failed: ' + (e && e.message ? e.message : e)
    console.error('✖ worldCreateScene failed:', e)
    return String(e && e.message ? e.message : e)
  } finally {
    creating = false
  }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ABot-World / QVAC SDK</title>
<style>body{margin:0;background:#0e1116;color:#dfe6ee;font:15px/1.5 system-ui}
.wrap{max-width:900px;margin:22px auto;padding:0 14px}
h1{font-size:17px;font-weight:650}h1 b{color:#6cc4ff}
.stage{position:relative;background:#000;border-radius:10px;overflow:hidden;min-height:220px}
.stage img{width:100%;display:block;min-height:220px;object-fit:contain}
.overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
background:#0b0e12e6;color:#9fb2c5;font-size:16px;text-align:center;padding:20px}
.overlay[hidden]{display:none!important}
.hud{display:flex;gap:22px;margin-top:10px;color:#9fb2c5;flex-wrap:wrap}
.hud b{color:#dfe6ee}.cap{margin-top:6px;color:#5d7186;font-size:13px}
.card{background:#141a20;border:1px solid #26313c;border-radius:10px;padding:12px 14px;margin:12px 0;
display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input[type=text]{flex:1;min-width:220px;background:#0e1116;border:1px solid #35485c;border-radius:6px;
color:#dfe6ee;padding:7px 10px;font:inherit}
button{background:#1f6feb;border:0;border-radius:6px;color:#fff;padding:8px 16px;font:inherit;
font-weight:650;cursor:pointer}button:disabled{background:#2d3a48;cursor:default}
kbd{background:#1d2733;border:1px solid #35485c;border-radius:5px;padding:2px 7px;margin:0 2px;font-weight:650}
kbd.on{background:#1f7a3d;border-color:#3fd06d;color:#fff}</style></head><body><div class="wrap">
<h1>ABot-World — interactive world model, driven by the <b>QVAC SDK</b></h1>
<div class="card">
<input type="file" id="file" accept="image/jpeg,image/png">
<input type="text" id="promptText" placeholder="optional prompt, e.g. 'rainy neon street at night'">
<button id="go" disabled>Create world</button>
</div>
<div class="stage"><img src="/stream" alt="walk"><div class="overlay" id="ov">upload a photo to create a world</div></div>
<div class="hud"><span>block <b id="b">0</b></span><span><b id="ms">0</b> ms/block</span>
<span>gen <b id="fps">0</b> fps</span><span>play <b id="pace">0</b> ms/frame</span>
<span id="keys"></span><span id="ph"></span></div>
<div class="cap">prompt in use: <b id="pr">(none yet)</b></div>
<div class="cap">walk: <b>W/A/S/D</b> move &middot; <b>I/J/K/L</b> look &mdash;
loadModel({ mode:'world' }) &middot; worldCreateScene({ prompt, image }) &middot; worldStep({ keys }) &mdash; @qvac/sdk &middot; @qvac/diffusion-cpp 0.19.0</div>
</div><script>
// Look every element up explicitly. Relying on id-named globals silently
// fails for any id that collides with a built-in window property: with
// id="prompt", \`prompt\` stays window.prompt (the native dialog function),
// so \`prompt.value\` was undefined and every world was created with the
// literal string "undefined" instead of the typed text.
const el=id=>document.getElementById(id)
const promptEl=el('promptText'),fileEl=el('file'),goEl=el('go'),ovEl=el('ov')
const blockEl=el('b'),msEl=el('ms'),fpsEl=el('fps'),paceEl=el('pace'),keysEl=el('keys'),phaseEl=el('ph'),prEl=el('pr')
const KEYS=['W','A','S','D','I','J','K','L'];const heldK=new Set()
function send(){fetch('/keys',{method:'POST',body:JSON.stringify([...heldK])})}
addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return
const k=e.key.toUpperCase();if(KEYS.includes(k)&&!heldK.has(k)){heldK.add(k);send()}})
addEventListener('keyup',e=>{if(e.target.tagName==='INPUT')return
const k=e.key.toUpperCase();if(heldK.delete(k))send()})
fileEl.onchange=()=>{goEl.disabled=!fileEl.files.length}
goEl.onclick=async()=>{
  const f=fileEl.files[0];if(!f)return
  goEl.disabled=true;goEl.textContent='Creating…'
  const r=await fetch('/create-world?prompt='+encodeURIComponent(promptEl.value),{method:'POST',body:await f.arrayBuffer()})
  if(!r.ok){const j=await r.json().catch(()=>({}));alert('create failed: '+(j.error||r.status))}
  goEl.textContent='Create world';goEl.disabled=!fileEl.files.length
}
setInterval(async()=>{const s=await(await fetch('/state')).json()
blockEl.textContent=s.block;msEl.textContent=s.lastMs;phaseEl.textContent=s.phase
fpsEl.textContent=s.lastMs?(12000/s.lastMs).toFixed(1):'0'
paceEl.textContent=s.paceMs||0
prEl.textContent=s.prompt||'(none yet)'
keysEl.innerHTML=KEYS.map(k=>'<kbd class="'+(s.keys.includes(k)?'on':'')+'">'+k+'</kbd>').join('')
ovEl.hidden=s.phase==='walking'
if(!ovEl.hidden)ovEl.textContent=s.hasWorld?s.phase:(s.phase==='upload a photo to create a world'||s.phase.startsWith('create')||s.phase.startsWith('reload')||s.phase.startsWith('creating')?s.phase:s.phase)},400)
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(PAGE)
    return
  }
  if (req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(state))
    return
  }
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store'
    })
    clients.add(res)
    res.on('close', () => clients.delete(res))
    if (latest) broadcast(latest)
    return
  }
  if (req.method === 'POST' && req.url === '/keys') {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      try {
        held.clear()
        for (const k of JSON.parse(body || '[]')) held.add(String(k).toUpperCase())
      } catch {}
      res.writeHead(200)
      res.end('{}')
    })
    return
  }
  if (req.method === 'POST' && req.url.startsWith('/create-world')) {
    if (creating) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'world creation already in progress' }))
      return
    }
    if (!modelId) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'model still loading, try again in a few seconds' }))
      return
    }
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > MAX_IMAGE_BYTES) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', async () => {
      const image = Buffer.concat(chunks)
      if (image.length < 100) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'body must be the image bytes (JPEG or PNG)' }))
        return
      }
      const q = req.url.indexOf('?')
      const params = new URLSearchParams(q === -1 ? '' : req.url.slice(q + 1))
      const err = await createWorld(image, (params.get('prompt') || '').trim())
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

async function main() {
  server.listen(PORT, HOST, () => console.log(`demo page: http://${HOST}:${PORT}/`))
  modelId = await loadWorldModel()
  state.phase = 'upload a photo to create a world'
  console.log('▸ ready — upload a photo in the browser to create a world')

  process.on('SIGINT', () => {
    stopRequested = true
    if (!walking && !stepping) {
      ;(async () => {
        console.log('▸ unloading model ...')
        try {
          if (modelId) await unloadModel({ modelId, clearStorage: false })
        } catch {}
        process.exit(0)
      })()
    }
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

#!/usr/bin/env node
'use strict'
// Run the VLM fixture through llama-server (plain Node >= 18, not Bare). Starts the
// server once, waits for /health, sends one warmup request (block 0), then posts each
// fixture item to /v1/chat/completions. Emits the same [VLMMETA]/[VLMSEG]/[VLMROW]
// markers as harness.cjs, so aggregate.js / combine.cjs score and render both legs.
//
// The request mirrors the addon harness: system message, then one user turn with the
// image followed by the prompt; greedy (temp 0, seed 42); per-item max_tokens; prompt
// cache off so every request prefills in full, as the addon does. Engine parameters
// come from QVAC_VLM_PARAMS, the same JSON the addon leg reads (see harness.cjs).
//
// Usage (run-local.cjs drives this; see LOCAL.md):
//   QVAC_VLM_PARAMS='{…}' node server-runner.cjs --binary <llama-server> --llm <gguf>
//     --mmproj <gguf> --backend cpu|gpu --preset <name> [--samples N] [--repeats N]
//     [--tasks a,b] [--fixture-dir <dir>] [--port 8089] [--source-ref <ref>]
//     [--label <model label>] [--server-log <file>]

const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const http = require('http')
const cp = require('child_process')
const crypto = require('crypto')
const config = require('./config.cjs')
const { parseArgs } = require('./utils')
const { selectItems, nPredictFor, predCapFor } = require('./items.cjs')

const SOURCE = 'llama-server'
const SYSTEM_PROMPT = 'You are a helpful assistant.'
const HEALTH_TIMEOUT_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const VISION_RE = /image (?:slice )?encoded in\s+(\d+(?:\.\d+)?)\s*ms/gi
const TS_RE = /^(\d+)\.(\d{2})\.(\d{3})\.(\d{3}) /
const ENC_START_RE = /encoding mtmd batch/
const ENC_END_RE = /decoding image batch/
const TILES_RE = /clip_encode: encoding (\d+) tile/

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// llama-server arguments matching the addon's load config (harness.cjs paramsConfig).
// --reasoning off: the addon renders the template with thinking disabled when its
// reasoning budget is 0; --reasoning-budget alone only limits the sampler.
// params.poll pins threadpool polling on both engines, whose defaults differ (addon
// 0, llama-server 50); the addon's batch polling follows its poll.
// --verbosity 4 + --log-timestamps: the `encoding mtmd batch` line that starts the
// vision-encode timing (visionOf) is logged at TRACE. TRACE lines are per request
// and per batch, not per token (per-token logging is DEBUG, level 5); text runs pass
// a.verbosity 2 only to keep their logs short.
// a.parallel > 1 mirrors the addon's continuous batching: N slots, each with
// ctx/N of a non-unified KV cache.
// The API key is passed in the LLAMA_API_KEY environment variable (serverEnv), not
// on the command line, so other local users cannot read it from the process list.
function serverArgs (a, params) {
  const gpu = a.backend === 'gpu'
  const parallel = a.parallel || 1
  const args = [
    '--model', a.llm,
    '--host', '127.0.0.1',
    '--port', String(a.port),
    '--ctx-size', String(params.ctxSize),
    '--parallel', String(parallel),
    '--seed', '42',
    '--jinja',
    '--reasoning', 'off',
    '--reasoning-budget', '0',
    '--cache-ram', '0',
    '--no-webui',
    '--verbosity', String(a.verbosity != null ? a.verbosity : 4),
    '--log-timestamps'
  ]
  if (a.mmproj) args.push('--mmproj', a.mmproj)
  if (parallel > 1) args.push('--no-kv-unified')
  if (params.threads != null) args.push('--threads', String(params.threads))
  if (params.batchSize != null) args.push('--batch-size', String(params.batchSize))
  if (params.ubatchSize != null) args.push('--ubatch-size', String(params.ubatchSize))
  if (params.flashAttn != null) args.push('--flash-attn', String(params.flashAttn))
  if (params.cacheTypeK != null) args.push('--cache-type-k', String(params.cacheTypeK))
  if (params.cacheTypeV != null) args.push('--cache-type-v', String(params.cacheTypeV))
  if (params.fit != null) args.push('--fit', String(params.fit))
  if (params.poll != null) args.push('--poll', String(params.poll), '--poll-batch', String(params.poll))
  if (params.imageMaxTokens != null) args.push('--image-max-tokens', String(params.imageMaxTokens))
  if (gpu) {
    // The addon runs on one device (split-mode none) by default.
    args.push('--gpu-layers', String(params.gpuLayers != null ? params.gpuLayers : 99), '--split-mode', 'none')
    if (a.mmproj && params.mmprojGpu === false) args.push('--no-mmproj-offload')
  } else {
    args.push('--gpu-layers', '0', '--device', 'none')
    if (a.mmproj) args.push('--no-mmproj-offload')
  }
  return args
}

function serverEnv (apiKey) {
  return { ...process.env, LLAMA_API_KEY: apiKey }
}

// Stop the server and close its log stream only after its output has drained
// ('close', not 'exit'), so shutdown lines are kept. A server still up after 15 s is
// killed, so the next job does not find the port taken.
async function stopServer (child, logStream) {
  const closed = new Promise(resolve => child.once('close', resolve))
  if (child.exitCode == null && child.signalCode == null) {
    child.kill()
    const timedOut = await Promise.race([closed.then(() => false), sleep(15000).then(() => true)])
    if (timedOut) {
      child.kill('SIGKILL')
      await Promise.race([closed, sleep(5000)])
    }
  } else if (![child.stdout, child.stderr].every(s => !s || s.destroyed)) {
    await Promise.race([closed, sleep(5000)])
  }
  if (logStream && !logStream.writableEnded) logStream.end()
}

function portFree (port) {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// Peak RSS (MB) of a child process. Linux reads the kernel high-water mark and
// Windows PeakWorkingSet64; macOS has no per-pid peak, so it reads the current RSS.
// All reads are async so they never stall the timed request loop.
function rssOf (pid) {
  return new Promise(resolve => {
    if (os.platform() === 'linux') {
      fs.readFile(`/proc/${pid}/status`, 'utf8', (err, txt) => {
        const m = !err && txt.match(/VmHWM:\s*(\d+)\s*kB/)
        resolve(m ? Math.round(parseInt(m[1], 10) / 1024) : null)
      })
      return
    }
    const [cmd, args, toMb] = os.platform() === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PeakWorkingSet64`], v => v / 1048576]
      : ['ps', ['-o', 'rss=', '-p', String(pid)], v => v / 1024]
    cp.execFile(cmd, args, { encoding: 'utf8', timeout: 10000 }, (err, out) => {
      const v = err ? NaN : parseInt(String(out).trim(), 10)
      resolve(Number.isFinite(v) ? Math.round(toMb(v)) : null)
    })
  })
}

function startRssSampler (pid) {
  let peak = null
  let busy = false
  const sample = async () => {
    if (busy) return
    busy = true
    const v = await rssOf(pid)
    if (v != null && (peak == null || v > peak)) peak = v
    busy = false
  }
  // Sampled only between requests (each peak() call): a background poll would fork
  // `ps` on the server leg alone while it is being timed. On macOS this reads the
  // RSS after each request, which plateaus once the model and buffers are loaded.
  return { peak: async () => { await sample(); return peak }, stop: () => {} }
}

// POST a streamed chat completion and call onEvent for every SSE `data:` JSON object.
// node:http rather than fetch: llama-server sends the response headers only with the
// first token, and fetch gives up after 300 s without headers, so a long prefill
// would fail on this leg only. agent: false gives every request its own connection,
// so a pooled keep-alive socket to an earlier server on the same port is never reused.
function postStream (url, headers, body, timeoutMs, onEvent) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      agent: false,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.setEncoding('utf8')
      if (res.statusCode !== 200) {
        let text = ''
        res.on('data', d => { text += d })
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`)))
        return
      }
      let buf = ''
      res.on('data', d => {
        buf += d
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          let evt
          try { evt = JSON.parse(data) } catch (_) { continue }
          try { onEvent(evt) } catch (e) { req.destroy(e); return }
        }
      })
      res.on('end', resolve)
      res.on('error', reject)
    })
    const timer = setTimeout(() => req.destroy(new Error(`request timed out after ${timeoutMs / 1000} s`)), timeoutMs)
    req.on('error', reject)
    req.on('close', () => clearTimeout(timer))
    req.end(body)
  })
}

function mimeOf (file) {
  const ext = path.extname(file).toLowerCase()
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
}

async function waitHealthy (base, child, headers) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`llama-server exited with code ${child.exitCode} before becoming healthy`)
    try {
      const r = await fetch(`${base}/health`, { headers })
      if (r.ok) return
    } catch (_) {}
    await sleep(500)
  }
  throw new Error('llama-server did not become healthy in time')
}

// Request body per image, built once and reused across repeats so encoding and
// serialisation stay out of the timed window. The addon folds a media message into
// the next user turn (marker first), so the image and prompt share one user message.
const bodyCache = new Map()
function requestBody (imgPath, prompt, maxTokens) {
  const key = `${imgPath}\0${prompt}\0${maxTokens}`
  if (!bodyCache.has(key)) {
    const bytes = fs.readFileSync(imgPath)
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeOf(imgPath)};base64,${bytes.toString('base64')}` } },
            { type: 'text', text: prompt }
          ]
        }
      ],
      max_tokens: maxTokens,
      temperature: 0,
      seed: 42,
      stream: true,
      cache_prompt: false
    })
    bodyCache.set(key, { body, dims: dimsFromBytes(bytes) })
  }
  return bodyCache.get(key)
}

// One streamed chat completion. Returns text, wall/first-token times and the server's
// own timings (attached to the final stream chunk).
async function complete (base, headers, imgPath, prompt, maxTokens) {
  const { body, dims } = requestBody(imgPath, prompt, maxTokens)
  const parts = []
  let firstTokenMs = null
  let timings = null
  const t0 = Date.now()
  await postStream(`${base}/v1/chat/completions`, headers, body, REQUEST_TIMEOUT_MS, evt => {
    if (evt.error) throw new Error(`server error: ${JSON.stringify(evt.error).slice(0, 500)}`)
    const delta = evt.choices && evt.choices[0] && evt.choices[0].delta
    if (delta && delta.content) {
      if (firstTokenMs == null) firstTokenMs = Date.now() - t0
      parts.push(delta.content)
    }
    if (evt.timings) timings = evt.timings
  })
  return { text: parts.join(''), ms: Date.now() - t0, firstTokenMs, timings, dims }
}

// PNG/JPEG dimensions; same reader as harness.cjs.
function dimsFromBytes (bytes) {
  try {
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let o = 2
      while (o + 9 < bytes.length) {
        if (bytes[o] !== 0xff) { o++; continue }
        const m = bytes[o + 1]
        if (m >= 0xc0 && m <= 0xc3) return { h: bytes.readUInt16BE(o + 5), w: bytes.readUInt16BE(o + 7) }
        o += 2 + bytes.readUInt16BE(o + 2)
      }
    }
  } catch (_) {}
  return { w: null, h: null }
}

// Vision-encode time in a log segment. llama-server encodes through
// mtmd_batch_encode, which logs no duration: time it from the `encoding mtmd batch`
// line to the first `decoding image batch` line after it (log timestamps are
// min.sec.ms.us). Falls back to summing `image slice encoded in N ms` lines.
function visionOf (seg) {
  let ms = 0
  let tiles = 0
  let start = null
  for (const line of seg.split('\n')) {
    const ts = line.match(TS_RE)
    const us = ts ? ((Number(ts[1]) * 60 + Number(ts[2])) * 1000 + Number(ts[3])) * 1000 + Number(ts[4]) : null
    if (ENC_START_RE.test(line)) start = us
    else if (start != null && us != null && ENC_END_RE.test(line)) { ms += (us - start) / 1000; start = null }
    const t = line.match(TILES_RE)
    if (t) tiles += Number(t[1])
  }
  if (ms > 0) return { ms, tiles: tiles || null }
  let n = 0
  let m
  VISION_RE.lastIndex = 0
  while ((m = VISION_RE.exec(seg)) !== null) { ms += Number(m[1]); n++ }
  return n ? { ms, tiles: n } : { ms: null, tiles: null }
}

async function main () {
  const a = parseArgs(process.argv.slice(2))
  for (const k of ['binary', 'llm', 'mmproj']) {
    if (typeof a[k] !== 'string' || !fs.existsSync(a[k])) { console.error(`[server-runner] --${k} missing or not found: ${a[k] || ''}`); process.exit(2) }
  }
  a.backend = a.backend || 'cpu'
  a.port = parseInt(a.port || '8089', 10)
  const presetName = a.preset || 'smoke'
  const preset = config.presets[presetName]
  if (!preset) { console.error(`[server-runner] unknown preset '${presetName}'`); process.exit(2) }
  const params = Object.assign({ ctxSize: 4096 }, process.env.QVAC_VLM_PARAMS ? JSON.parse(process.env.QVAC_VLM_PARAMS) : {})
  const samples = a.samples ? parseInt(a.samples, 10) : null
  const repeats = parseInt(a.repeats || String(preset.repeats || 1), 10)
  const tasks = a.tasks ? String(a.tasks).split(',').map(s => s.trim()).filter(Boolean) : null
  const fixtureDir = path.resolve(a['fixture-dir'] || path.join(__dirname, 'fixture'))
  const label = a.label || path.basename(a.llm).replace(/\.gguf$/i, '')
  const items = selectItems(preset, { samples, tasks })
  const stampBase = { v: 2, scenario: config.defaultScenario || 'default', source_id: SOURCE, source_ref: a['source-ref'] || '' }
  const tag = { cell: SOURCE, source: SOURCE, model: label, device: a.backend }

  if (!(await portFree(a.port))) {
    console.error(`[server-runner] port ${a.port} is already in use; pass --port <free port>`)
    process.exit(2)
  }

  console.error('[VLMMETA]' + JSON.stringify({
    ...stampBase,
    cell: SOURCE,
    source: SOURCE,
    model: label,
    main_origin: `${path.basename(a.llm)} (local)`,
    main_url: `file://${a.llm}`,
    main_source: 'Local',
    mmproj_origin: `${path.basename(a.mmproj)} (local)`,
    mmproj_url: `file://${a.mmproj}`,
    mmproj_source: 'Local'
  }) + '[/VLMMETA]')

  // Per-run key: the server is reachable from any local process for the run's duration.
  const apiKey = crypto.randomBytes(16).toString('hex')
  const headers = { Authorization: `Bearer ${apiKey}` }
  const args = serverArgs(a, params)
  console.error(`[server-runner] ${a.binary} ${args.join(' ')}`)
  const child = cp.spawn(a.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(a.binary), env: serverEnv(apiKey) })
  // Server output since the current request started; reset per request.
  let logTail = ''
  const serverLog = a['server-log'] ? fs.createWriteStream(a['server-log']) : null
  const onData = d => {
    const s = d.toString()
    logTail += s
    if (serverLog && !serverLog.writableEnded) serverLog.write(s)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const kill = () => { if (child.exitCode == null) child.kill() }
  process.on('SIGINT', () => { kill(); process.exit(130) })
  process.on('SIGTERM', () => { kill(); process.exit(143) })

  const base = `http://127.0.0.1:${a.port}`
  const rss = startRssSampler(child.pid)
  let ok = 0
  try {
    await waitHealthy(base, child, headers)
    if (child.exitCode != null) throw new Error(`llama-server exited with code ${child.exitCode}`)

    const runItem = async (item, rep, block) => {
      console.error('[VLMSEG]' + JSON.stringify({ ...stampBase, ...tag, id: item.id, rep, block }) + '[/VLMSEG]')
      logTail = ''
      const row = { ...stampBase, block, ...tag, rep, task: item.task, id: item.id, metric: item.metric }
      try {
        const r = await complete(base, headers, path.join(fixtureDir, item.image), item.prompt, nPredictFor(item.task))
        // The encode line is logged before the first token; allow a short grace for
        // the server's async logger to flush it.
        let vis = visionOf(logTail)
        for (let i = 0; i < 10 && vis.ms == null; i++) { await sleep(50); vis = visionOf(logTail) }
        const t = r.timings || {}
        Object.assign(row, {
          rss_mb: await rss.peak(),
          pred: String(r.text).slice(0, predCapFor(item.task)),
          img: item.image,
          img_w: r.dims.w,
          img_h: r.dims.h,
          ms: r.ms,
          decode_tps: t.predicted_per_second != null ? t.predicted_per_second : null,
          ttft_ms: t.prompt_ms != null ? t.prompt_ms : null,
          pp_tps: t.prompt_per_second != null ? t.prompt_per_second : null,
          client_ttft_ms: r.firstTokenMs,
          gen_tokens: t.predicted_n != null ? t.predicted_n : null,
          prompt_tokens: t.prompt_n != null ? t.prompt_n + (t.cache_n || 0) : null,
          vision_enc_ms: vis.ms,
          vision_enc_tiles: vis.tiles
        })
        if (block !== 0) ok++
      } catch (e) {
        Object.assign(row, { rss_mb: await rss.peak(), error: String((e && e.message) || e) })
      }
      console.log('[VLMROW]' + JSON.stringify(row) + '[/VLMROW]')
    }

    if (items.length) await runItem(items[0], 0, 0)
    for (const item of items) {
      for (let rep = 0; rep < repeats; rep++) await runItem(item, rep, rep + 1)
    }
  } finally {
    rss.stop()
    await stopServer(child, serverLog)
  }
  console.error(`[server-runner] ${SOURCE}/${a.backend}: ${ok}/${items.length * repeats} ok`)
  if (!ok && items.length) process.exitCode = 1
}

if (require.main === module) main().catch(e => { console.error(`[server-runner] ${e.stack || e}`); process.exit(1) })

module.exports = { serverArgs, serverEnv, stopServer, portFree, startRssSampler, waitHealthy, postStream, sleep }

'use strict'

const http = require('bare-http1')
const process = require('bare-process')
const { VlaModel } = require('@qvac/vla')

const MODEL_PATH = process.env.QVAC_VLA_MODEL
if (!MODEL_PATH) {
  console.error('vla-server: QVAC_VLA_MODEL env var is required (path to .gguf)')
  process.exit(1)
}
const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8765)

// Cap the request body so a single oversized POST can't exhaust the heap. A
// legitimate /predict body is ~3 MB (two 512×512×3 f32 images dominate); 32
// MB leaves comfortable headroom for noise + tokens + alignment slack.
const MAX_BODY_BYTES = 32 * 1024 * 1024

console.log(`vla-server: loading ${MODEL_PATH}`)
// `opts: { stats: true }` makes VlaModel surface per-stage timings on the
// QvacResponse — without it `result.stats` is null and the wire-format
// `stats` field would be empty.
const model = new VlaModel({ files: { model: [MODEL_PATH] }, opts: { stats: true } })

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error(`request body exceeds MAX_BODY_BYTES (${MAX_BODY_BYTES})`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks, total)))
    req.on('error', reject)
  })
}

function alignedFloat32 (buf, byteOffset, count) {
  const out = new Float32Array(count)
  Buffer.from(out.buffer).set(buf.subarray(byteOffset, byteOffset + count * 4))
  return out
}

function alignedInt32 (buf, byteOffset, count) {
  const out = new Int32Array(count)
  Buffer.from(out.buffer).set(buf.subarray(byteOffset, byteOffset + count * 4))
  return out
}

function alignedUint8 (buf, byteOffset, count) {
  return new Uint8Array(buf.subarray(byteOffset, byteOffset + count))
}

// Validates that a value is an integer in [min, max]. Used for header fields
// that flow into typed-array lengths or C++ tensor allocators — without this,
// a crafted client could ask for `state_dim=2**30`, allocating gigabytes
// before the C++ side ever sees the request.
function validateInt (header, key, min, max) {
  const v = header[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`header.${key} must be an integer in [${min}, ${max}] (got: ${v})`)
  }
  return v
}

function parseRequest (body) {
  if (body.length < 4) throw new Error('body shorter than header-length prefix')
  const headerLen = body.readUInt32LE(0)
  // headerLen has to fit in the body and be small. JSON header is tens of
  // bytes; a 64 KB cap is generous and keeps the JSON.parse cheap.
  if (headerLen > 65536 || 4 + headerLen > body.length) {
    throw new Error(`header_len ${headerLen} out of range`)
  }
  const headerJson = body.subarray(4, 4 + headerLen).toString('utf8')
  const header = JSON.parse(headerJson)

  // Bound every header field used to size a typed array. Limits chosen to
  // exceed any legitimate SmolVLA request by a healthy margin without
  // leaving room for adversarial multi-GB allocations.
  const stateDim = validateInt(header, 'state_dim', 0, 64)
  const nImages = validateInt(header, 'n_images', 1, 16)
  const imgW = validateInt(header, 'img_w', 1, 1024)
  const imgH = validateInt(header, 'img_h', 1, 1024)
  const nTokens = validateInt(header, 'n_tokens', 0, 256)
  const hasNoise = !!header.has_noise

  let off = 4 + headerLen

  const state = alignedFloat32(body, off, stateDim)
  off += stateDim * 4

  const imgFloats = 3 * imgH * imgW
  const images = []
  for (let i = 0; i < nImages; i++) {
    images.push(alignedFloat32(body, off, imgFloats))
    off += imgFloats * 4
  }

  const tokens = alignedInt32(body, off, nTokens)
  off += nTokens * 4

  const mask = alignedUint8(body, off, nTokens)
  off += nTokens

  let noise = null
  if (hasNoise) {
    const noiseLen = model.hparams.chunkSize * model.hparams.maxActionDim
    noise = alignedFloat32(body, off, noiseLen)
    off += noiseLen * 4
  }

  if (off > body.length) {
    throw new Error(`body truncated: read ${off} bytes from ${body.length}`)
  }

  return { state, images, tokens, mask, noise, imgWidth: imgW, imgHeight: imgH }
}

function encodeResponse (actions, stats) {
  const header = {
    chunk_size: model.hparams.chunkSize,
    action_dim: model.hparams.actionDim,
    stats
  }
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
  const actionBuf = Buffer.from(actions.buffer, actions.byteOffset, actions.byteLength)
  const out = Buffer.alloc(4 + headerBuf.length + actionBuf.length)
  out.writeUInt32LE(headerBuf.length, 0)
  headerBuf.copy(out, 4)
  actionBuf.copy(out, 4 + headerBuf.length)
  return out
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now()
  try {
    if (req.method === 'GET' && req.url === '/info') {
      // Don't expose the on-disk GGUF path — it leaks server filesystem layout.
      const body = JSON.stringify({ hparams: model.hparams })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    if (req.method === 'POST' && req.url === '/predict') {
      const body = await readBody(req)
      const opts = parseRequest(body)
      // model.run() returns a QvacResponse — the actual `{ actions, stats }`
      // payload comes from response.await(). Single-step destructuring would
      // give `actions === undefined` and crash encodeResponse below.
      // Canonical pattern, mirrors test/integration/addon.test.js:513-514.
      const response = await model.run(opts)
      const { actions, stats } = await response.await()
      const out = encodeResponse(actions, stats)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(out.length)
      })
      res.end(out)
      console.log(`predict ok: total_ms=${stats.total_ms.toFixed(1)} server_ms=${Date.now() - t0}`)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  } catch (err) {
    console.error('predict error:', err && err.stack || err)
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(err && err.message || err))
  }
})

// VlaModel.load is async (the published @qvac/vla API), so we boot the server
// inside an async IIFE that awaits the load before listen() begins accepting
// connections. Otherwise the first request races the weight upload and 500s.
;(async () => {
  await model.load()
  console.log('vla-server: model loaded, hparams:', model.hparams)
  server.listen(PORT, HOST, () => {
    console.log(`vla-server listening on http://${HOST}:${PORT}`)
  })
})().catch((err) => {
  console.error('vla-server: failed to start:', err && err.stack || err)
  process.exit(1)
})

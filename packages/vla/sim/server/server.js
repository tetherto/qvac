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

console.log(`vla-server: loading ${MODEL_PATH}`)
const model = new VlaModel(MODEL_PATH)
console.log('vla-server: model loaded, hparams:', model.hparams)

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => { chunks.push(c); total += c.length })
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

function parseRequest (body) {
  const headerLen = body.readUInt32LE(0)
  const headerJson = body.subarray(4, 4 + headerLen).toString('utf8')
  const header = JSON.parse(headerJson)
  let off = 4 + headerLen

  const state = alignedFloat32(body, off, header.state_dim)
  off += header.state_dim * 4

  const imgFloats = 3 * header.img_h * header.img_w
  const images = []
  for (let i = 0; i < header.n_images; i++) {
    images.push(alignedFloat32(body, off, imgFloats))
    off += imgFloats * 4
  }

  const tokens = alignedInt32(body, off, header.n_tokens)
  off += header.n_tokens * 4

  const mask = alignedUint8(body, off, header.n_tokens)
  off += header.n_tokens

  let noise = null
  if (header.has_noise) {
    const noiseLen = model.hparams.chunkSize * model.hparams.maxActionDim
    noise = alignedFloat32(body, off, noiseLen)
    off += noiseLen * 4
  }

  return { state, images, tokens, mask, noise, imgWidth: header.img_w, imgHeight: header.img_h }
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
      const body = JSON.stringify({ hparams: model.hparams, model_path: MODEL_PATH })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    if (req.method === 'POST' && req.url === '/predict') {
      const body = await readBody(req)
      const opts = parseRequest(body)
      const { actions, stats } = model.run(opts)
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

server.listen(PORT, HOST, () => {
  console.log(`vla-server listening on http://${HOST}:${PORT}`)
})

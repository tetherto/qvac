'use strict'

// Numerical guards for the ABot-World lanes, shared with the unit lane.
//
// Both exist because the ABot regressions that actually shipped were invisible
// to structural assertions. The 2026-08-11 engine port dropped the reference's
// prompt-padding zeroing, so scene packs carried live pad-token embeddings in
// all 512 context rows; generation then collapsed into blur within the first
// block while frame counts, dimensions, progress events and
// frames-differ-between-blocks all still passed.
//
// readScenePackPromptRows() catches that at its root, from the pack file alone
// - no DiT, no GPU, no generated frames - and pngLuminanceStddev() is the
// pixel-level backstop for anything else that washes the output out.
//
// Kept to bare-zlib so the unit lane can exercise both without models, a GPU
// or a native prebuild.

const zlib = require('bare-zlib')

// Mean-subtracted luminance spread of an 8-bit RGB PNG frame. Healthy ABot
// walk frames measure 30+ (photo and synthetic scenes alike, idle or moving,
// on CPU/CUDA/Vulkan); frames from a conditioning collapse measure 8-12.
// Returns -1 for anything that is not an 8-bit truecolour PNG.
function pngLuminanceStddev(png) {
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString('latin1', pos + 4, pos + 8)
    const chunk = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]
      colorType = chunk[9]
    } else if (type === 'IDAT') {
      idat.push(chunk)
    }
    pos += 12 + len
  }
  if (bitDepth !== 8 || colorType !== 2) return -1

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 3
  let prev = Buffer.alloc(stride)
  let sum = 0
  let sumSq = 0
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? line[i - 3] : 0
      const b = prev[i]
      if (filter === 1) line[i] = (line[i] + a) & 255
      else if (filter === 2) line[i] = (line[i] + b) & 255
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const c = i >= 3 ? prev[i - 3] : 0
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    for (let i = 0; i < stride; i += 3) {
      const yv = 0.299 * line[i] + 0.587 * line[i + 1] + 0.114 * line[i + 2]
      sum += yv
      sumSq += yv * yv
    }
    prev = line
  }
  const n = width * height
  const mean = sum / n
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean))
}

// Prompt-row census of a scene pack (safetensors), read from its bytes.
//
// The producer zeroes every embedding row past the last real token, mirroring
// the reference text encoder's `u[v:] = 0`, so `live` is the prompt's token
// count and `live === rows` means the padding was NOT zeroed - the pack will
// condition the walk on pad embeddings. `prefix` is the live rows, for
// comparing two packs (a prompt-insensitive encoder returns the same bytes for
// different prompts).
function readScenePackPromptRows(buf) {
  const headerLen = Number(buf.readBigUInt64LE(0))
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen))
  const meta = header.prompt_embeds
  if (!meta) throw new Error('scene pack has no prompt_embeds tensor')
  if (meta.dtype !== 'F32') throw new Error(`prompt_embeds dtype ${meta.dtype}, expected F32`)
  // torch shape [1, rows, emb]; trailing dim is the embedding width
  const shape = meta.shape
  const emb = shape[shape.length - 1]
  const rows = shape[shape.length - 2]
  const base = 8 + headerLen + meta.data_offsets[0]

  let live = 0
  for (let r = rows - 1; r >= 0; r--) {
    let nonZero = false
    const rowStart = base + r * emb * 4
    for (let i = 0; i < emb; i++) {
      if (buf.readFloatLE(rowStart + i * 4) !== 0) {
        nonZero = true
        break
      }
    }
    if (nonZero) {
      live = r + 1
      break
    }
  }
  return {
    rows,
    emb,
    live,
    prefix: buf.subarray(base, base + live * emb * 4)
  }
}

module.exports = { pngLuminanceStddev, readScenePackPromptRows }

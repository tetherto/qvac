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

// Decode an 8-bit truecolour PNG, or return null for unsupported pixel formats.
function pngRgb(png) {
  // Frames arrive as Uint8Array from the addon's live stream but as Buffer
  // from a disk read; normalize to Buffer (zero-copy view) so the readUInt32BE
  // / toString helpers below work on both.
  if (!Buffer.isBuffer(png)) png = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
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
  if (bitDepth !== 8 || colorType !== 2) return null

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 3
  let prev = Buffer.alloc(stride)
  const pixels = Buffer.alloc(width * height * 3)
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
    pixels.set(line, y * stride)
    prev = line
  }
  return { pixels, width, height }
}

// Mean-subtracted luminance spread. Healthy ABot walk frames measure 30+;
// conditioning collapses measure 8-12. Returns -1 for unsupported formats.
function pngLuminanceStddev(png) {
  const decoded = pngRgb(png)
  if (!decoded) return -1
  const { pixels } = decoded
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < pixels.length; i += 3) {
    const yv = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
    sum += yv
    sumSq += yv * yv
  }
  const n = pixels.length / 3
  const mean = sum / n
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean))
}

function pngMeanAbsoluteError(a, b) {
  const left = pngRgb(a)
  const right = pngRgb(b)
  if (!left || !right || left.width !== right.width || left.height !== right.height) {
    return Infinity
  }
  let total = 0
  for (let i = 0; i < left.pixels.length; i++) {
    total += Math.abs(left.pixels[i] - right.pixels[i])
  }
  return total / left.pixels.length
}

// Prompt-row census of a scene pack (safetensors), read from its bytes.
//
// The producer zeroes every embedding row past the last real token, mirroring
// the reference text encoder's `u[v:] = 0`. `live` is the COUNT of rows that
// carry any non-zero value - the prompt's token count when the padding is
// intact - and `lastNonZero` is the highest such row, so
// `live === lastNonZero + 1` proves the live rows form one leading block with
// no interior holes. Counting (rather than taking the last non-zero index)
// matters: a pack whose padding was only *partially* zeroed still reports a
// `live` near `rows`, where a last-index scan would have hidden it as
// "< rows". `prefix` is the leading live rows, for comparing two packs (a
// prompt-insensitive encoder returns the same bytes for different prompts).
//
// KNOWN DIVERGENCE FROM THE ENGINE LOG (read this before "fixing" a mismatch):
// the engine's load-time line `scene pack: prompt rows N live / M`
// (qvac-ext-stable-diffusion.cpp#37, AbotScenePack::load) computes N as
// "last non-zero row index + 1" and only WARNs at exactly N == M. This guard
// COUNTS the non-zero rows, bounds them at rows / 2 and checks contiguity. On
// a partially zeroed pack (e.g. 511/512 live) the two therefore disagree: the
// engine prints a high N at INFO level while this guard goes red. This guard
// is the authoritative gate; the engine line is observability only, and output
// quality is unaffected either way (the pad-zeroing fix itself is correct).
// Aligning the engine diagnostic to count semantics is deliberately deferred
// to the next ABot engine change (review thread on qvac#4232). Do not resolve
// the disagreement by loosening this guard.
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
  let lastNonZero = -1
  for (let r = 0; r < rows; r++) {
    const rowStart = base + r * emb * 4
    let nonZero = false
    for (let i = 0; i < emb; i++) {
      if (buf.readFloatLE(rowStart + i * 4) !== 0) {
        nonZero = true
        break
      }
    }
    if (nonZero) {
      live++
      lastNonZero = r
    }
  }
  return {
    rows,
    emb,
    live,
    lastNonZero,
    prefix: buf.subarray(base, base + live * emb * 4)
  }
}

async function waitForLogEvidence(evidence, markers, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (!markers.every((marker) => evidence.some((line) => line.includes(marker)))) {
    if (Date.now() >= deadline) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

module.exports = {
  pngLuminanceStddev,
  pngMeanAbsoluteError,
  readScenePackPromptRows,
  waitForLogEvidence
}

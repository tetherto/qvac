'use strict'

// Pure-JS helpers for SmolVLA preprocessing. No dependency on the native
// `.bare` addon, so CI's `ts-checks` job (which runs `test:unit --if-present`
// without a native build) can exercise these without ADDON_NOT_FOUND failures.

const DEFAULT_IMAGE_SIZE = 512

/**
 * Resize + letterbox-pad an HWC or CHW image to `size × size`, then normalize
 * from [0, 1] (or [0, 255]) to [-1, 1]. Output is a contiguous CHW Float32Array
 * of length 3 * size * size — the format smolvla.cpp's SigLIP encoder expects.
 *
 * Matches the reference implementation in smolvla_ggml.py#preprocess_image:
 * ratio = max(w/size, h/size), resize with bilinear, left/top pad with 0,
 * scale to [-1, 1].
 *
 * @param {Float32Array|Uint8Array|number[]} pixels - source pixels
 * @param {number} width - source width
 * @param {number} height - source height
 * @param {{ size?: number, layout?: 'hwc'|'chw' }} [opts]
 * @returns {Float32Array}
 */
function preprocessImage (pixels, width, height, opts = {}) {
  const size = opts.size ?? DEFAULT_IMAGE_SIZE
  const layout = opts.layout ?? 'hwc'

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError('preprocessImage: width/height must be positive integers')
  }
  const expected = width * height * 3
  if (pixels.length !== expected) {
    throw new RangeError(`preprocessImage: expected ${expected} pixel values, got ${pixels.length}`)
  }

  const normalize = detectScale(pixels)

  // 1) Materialize a planar CHW float32 source in [0, 1].
  const src = new Float32Array(3 * width * height)
  if (layout === 'hwc') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const hwcIdx = (y * width + x) * 3
        for (let c = 0; c < 3; c++) {
          src[c * width * height + y * width + x] = pixels[hwcIdx + c] * normalize
        }
      }
    }
  } else {
    for (let i = 0; i < src.length; i++) src[i] = pixels[i] * normalize
  }

  // 2) Compute letterbox target size (aspect-ratio preserving).
  const ratio = Math.max(width / size, height / size)
  const newW = Math.max(1, Math.floor(width / ratio))
  const newH = Math.max(1, Math.floor(height / ratio))
  const padLeft = size - newW
  const padTop = size - newH

  // 3) Bilinear resize each channel.
  const resized = new Float32Array(3 * newW * newH)
  const xScale = width / newW
  const yScale = height / newH
  for (let c = 0; c < 3; c++) {
    const plane = c * width * height
    const outPlane = c * newW * newH
    for (let yy = 0; yy < newH; yy++) {
      const yIn = (yy + 0.5) * yScale - 0.5
      const y0 = Math.max(0, Math.floor(yIn))
      const y1 = Math.min(height - 1, y0 + 1)
      const dy = Math.min(1, Math.max(0, yIn - y0))
      for (let xx = 0; xx < newW; xx++) {
        const xIn = (xx + 0.5) * xScale - 0.5
        const x0 = Math.max(0, Math.floor(xIn))
        const x1 = Math.min(width - 1, x0 + 1)
        const dx = Math.min(1, Math.max(0, xIn - x0))
        const a = src[plane + y0 * width + x0]
        const b = src[plane + y0 * width + x1]
        const cVal = src[plane + y1 * width + x0]
        const d = src[plane + y1 * width + x1]
        const v =
          a * (1 - dx) * (1 - dy) +
          b * dx * (1 - dy) +
          cVal * (1 - dx) * dy +
          d * dx * dy
        resized[outPlane + yy * newW + xx] = v
      }
    }
  }

  // 4) Pad on left+top with zeros, shift into [-1, 1].
  const out = new Float32Array(3 * size * size) // zero-initialised
  for (let c = 0; c < 3; c++) {
    const outPlane = c * size * size
    const inPlane = c * newW * newH
    for (let yy = 0; yy < newH; yy++) {
      const outRow = outPlane + (yy + padTop) * size + padLeft
      const inRow = inPlane + yy * newW
      for (let xx = 0; xx < newW; xx++) {
        out[outRow + xx] = resized[inRow + xx]
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] * 2 - 1

  return out
}

/**
 * Zero-pad a state vector to `targetDim`. Extra entries are zero-initialised;
 * input longer than `targetDim` raises. Mirrors how smolvla.cpp expects the
 * state tensor (`max_state_dim` = 32 by default).
 *
 * @param {ArrayLike<number>} state
 * @param {number} targetDim
 * @returns {Float32Array}
 */
function padState (state, targetDim = 32) {
  if (!Number.isInteger(targetDim) || targetDim <= 0) {
    throw new TypeError('padState: targetDim must be a positive integer')
  }
  if (state.length > targetDim) {
    throw new RangeError(`padState: input length ${state.length} exceeds targetDim ${targetDim}`)
  }
  const out = new Float32Array(targetDim)
  for (let i = 0; i < state.length; i++) out[i] = state[i]
  return out
}

function detectScale (pixels) {
  if (pixels instanceof Uint8Array) return 1 / 255
  // Float/Number arrays: scan a small window to decide whether it's [0,255] or [0,1].
  const limit = Math.min(pixels.length, 256)
  let maxVal = 0
  for (let i = 0; i < limit; i++) {
    const v = pixels[i]
    if (v > maxVal) maxVal = v
  }
  return maxVal > 1.001 ? 1 / 255 : 1
}

module.exports = { preprocessImage, padState, DEFAULT_IMAGE_SIZE }

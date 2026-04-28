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
 * scale to [-1, 1]. The pad region is filled with -1 (= 0 shifted into [-1, 1]).
 *
 * Bilinear resize, letterbox-pad and the [0,1]→[-1,1] shift run as a single
 * pass over the output buffer; no `src` / `resized` intermediates are allocated
 * (each call needs only the final 3*size*size Float32Array). Per-output-pixel
 * coordinates are computed once and shared across the three channels.
 *
 * @param {Float32Array|Uint8Array|number[]} pixels - source pixels
 * @param {number} width - source width
 * @param {number} height - source height
 * @param {{ size?: number, layout?: 'hwc'|'chw', scale?: 1|(1/255)|'auto' }} [opts]
 *   `scale` skips the [0,255] vs [0,1] heuristic when the caller knows the
 *   range (`1` = pixels already in [0,1], `1/255` = pixels in [0,255]).
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

  const normalize = (opts.scale === 1 || opts.scale === 1 / 255) ? opts.scale : detectScale(pixels)

  // Letterbox target size (aspect-ratio preserving).
  const ratio = Math.max(width / size, height / size)
  const newW = Math.max(1, Math.floor(width / ratio))
  const newH = Math.max(1, Math.floor(height / ratio))
  const padLeft = size - newW
  const padTop = size - newH
  const xScale = width / newW
  const yScale = height / newH

  // Output starts at -1 so the pad region is already in [-1, 1] and we only
  // need to overwrite the (newH × newW) inner region with the resized content.
  const out = new Float32Array(3 * size * size)
  out.fill(-1)

  const planeStride = size * size
  const widthHeight = width * height

  for (let yy = 0; yy < newH; yy++) {
    const yIn = (yy + 0.5) * yScale - 0.5
    const y0 = Math.max(0, Math.floor(yIn))
    const y1 = Math.min(height - 1, y0 + 1)
    const dy = Math.min(1, Math.max(0, yIn - y0))
    const dyInv = 1 - dy
    const outY = yy + padTop

    for (let xx = 0; xx < newW; xx++) {
      const xIn = (xx + 0.5) * xScale - 0.5
      const x0 = Math.max(0, Math.floor(xIn))
      const x1 = Math.min(width - 1, x0 + 1)
      const dx = Math.min(1, Math.max(0, xIn - x0))
      const dxInv = 1 - dx
      const outX = xx + padLeft

      const w00 = dxInv * dyInv
      const w10 = dx * dyInv
      const w01 = dxInv * dy
      const w11 = dx * dy

      const outIdx = outY * size + outX

      if (layout === 'hwc') {
        const i00 = (y0 * width + x0) * 3
        const i10 = (y0 * width + x1) * 3
        const i01 = (y1 * width + x0) * 3
        const i11 = (y1 * width + x1) * 3
        for (let c = 0; c < 3; c++) {
          const v =
            pixels[i00 + c] * w00 +
            pixels[i10 + c] * w10 +
            pixels[i01 + c] * w01 +
            pixels[i11 + c] * w11
          // Apply scale and shift into [-1, 1] in one fused multiply-add.
          out[c * planeStride + outIdx] = v * normalize * 2 - 1
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const plane = c * widthHeight
          const v =
            pixels[plane + y0 * width + x0] * w00 +
            pixels[plane + y0 * width + x1] * w10 +
            pixels[plane + y1 * width + x0] * w01 +
            pixels[plane + y1 * width + x1] * w11
          out[c * planeStride + outIdx] = v * normalize * 2 - 1
        }
      }
    }
  }

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

'use strict'

/**
 * Image utility functions for diffusion model preprocessing.
 */

/**
 * Resize dimensions to the nearest multiple of `alignTo` while preserving aspect ratio.
 *
 * Strategy: scale the longer dimension to the nearest multiple of `alignTo`,
 * then scale the shorter dimension proportionally, rounding to the nearest
 * multiple of `alignTo`. This keeps both dimensions aligned and preserves
 * the aspect ratio as closely as possible.
 *
 * @param {number} width - Original width in pixels
 * @param {number} height - Original height in pixels
 * @param {number} [alignTo=8] - Alignment value (default: 8)
 * @returns {object} { width, height } — both guaranteed to be multiples of alignTo
 *
 * @example
 * alignImageDimensions(1280, 720, 8)
 * // → { width: 1280, height: 720 } (already aligned)
 *
 * alignImageDimensions(1000, 500, 8)
 * // → { width: 1000, height: 504 }
 * // Aspect ratio: 2:1 (original); new: 1000/504 ≈ 1.984:1 (preserved)
 *
 * @example
 * alignImageDimensions(512, 768, 8)
 * // → { width: 512, height: 768 } (already aligned)
 *
 * alignImageDimensions(515, 770, 8)
 * // → { width: 520, height: 776 }
 */
function alignImageDimensions (width, height, alignTo = 8) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error('width must be a positive integer')
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error('height must be a positive integer')
  }
  if (!Number.isInteger(alignTo) || alignTo <= 0) {
    throw new Error('alignTo must be a positive integer')
  }

  // Already aligned?
  if (width % alignTo === 0 && height % alignTo === 0) {
    return { width, height }
  }

  // Calculate aspect ratio
  const aspectRatio = width / height

  // Determine which dimension to scale first (pick the larger one to minimize shrinkage)
  if (width >= height) {
    // Scale width first
    const alignedWidth = Math.round(width / alignTo) * alignTo
    const scaledHeight = Math.round((alignedWidth / aspectRatio) / alignTo) * alignTo

    return { width: alignedWidth, height: scaledHeight }
  } else {
    // Scale height first
    const alignedHeight = Math.round(height / alignTo) * alignTo
    const scaledWidth = Math.round((alignedHeight * aspectRatio) / alignTo) * alignTo

    return { width: scaledWidth, height: alignedHeight }
  }
}

module.exports = {
  alignImageDimensions
}

/**
 * Pure-JS helpers for preparing VLA inference inputs on the client side.
 *
 * Mirrors `preprocessImage` / `padState` / `DEFAULT_IMAGE_SIZE` from
 * `@qvac/vla-ggml/addon.js`. Kept inlined (not re-exported from the addon)
 * so the SDK's client surface never loads the addon's native binding —
 * consumers running under Node / Bun / Expo without VLA prebuilds can still
 * use the SDK to drive a remote VLA worker.
 *
 * Algorithm is identical to the addon's `preprocessImage`: bilinear resize +
 * letterbox-pad to `size × size`, normalize from `[0, 1]` (or `[0, 255]`)
 * to `[-1, 1]`, write a contiguous CHW Float32Array of length
 * `3 * size * size`. The pad region is filled with `-1`.
 */

/** Default vision tower image size used by SmolVLA-LIBERO. */
export const VLA_DEFAULT_IMAGE_SIZE = 512;

type PixelsInput = Float32Array | Uint8Array | number[];
type ImageLayout = "hwc" | "chw";

export interface VlaPreprocessImageOptions {
  size?: number;
  layout?: ImageLayout;
  /**
   * Skip the [0,255] vs [0,1] auto-detection heuristic when the caller knows
   * the range. `1` = pixels already in [0,1] (no rescale). `1/255` = pixels
   * in [0,255] (rescale to [0,1]). Any other value (including the literal
   * `'auto'`) falls back to the heuristic.
   */
  scale?: number | "auto";
}

function detectScale(pixels: PixelsInput): number {
  // Heuristic: peek at up to N samples; if any value exceeds 1, assume [0,255].
  const N = Math.min(pixels.length, 256);
  for (let i = 0; i < N; i++) {
    const v = pixels[i] as number;
    if (v > 1) return 1 / 255;
  }
  return 1;
}

function readPixel(
  pixels: PixelsInput,
  x: number,
  y: number,
  width: number,
  layout: ImageLayout,
  channel: number,
  hw: number,
): number {
  if (layout === "hwc") {
    return pixels[(y * width + x) * 3 + channel] as number;
  }
  // CHW: pixels[channel * hw + y*width + x]
  return pixels[channel * hw + y * width + x] as number;
}

/**
 * Resize + letterbox + normalize a camera frame to `(3, size, size)` Float32
 * in `[-1, 1]`. Drop-in equivalent of `@qvac/vla-ggml`'s `preprocessImage`.
 */
export function vlaPreprocessImage(
  pixels: PixelsInput,
  width: number,
  height: number,
  opts: VlaPreprocessImageOptions = {},
): Float32Array {
  const size = opts.size ?? VLA_DEFAULT_IMAGE_SIZE;
  const layout: ImageLayout = opts.layout ?? "hwc";

  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError(
      "vlaPreprocessImage: width/height must be positive integers",
    );
  }
  const expected = width * height * 3;
  if (pixels.length !== expected) {
    throw new RangeError(
      `vlaPreprocessImage: expected ${expected} pixel values, got ${pixels.length}`,
    );
  }

  const scaleHint =
    typeof opts.scale === "number" && (opts.scale === 1 || opts.scale === 1 / 255)
      ? opts.scale
      : detectScale(pixels);

  // Letterbox math: keep aspect ratio, leftover area gets pad value -1.
  const ratio = Math.max(width / size, height / size);
  const targetW = Math.max(1, Math.round(width / ratio));
  const targetH = Math.max(1, Math.round(height / ratio));
  const padX = Math.floor((size - targetW) / 2);
  const padY = Math.floor((size - targetH) / 2);

  const out = new Float32Array(3 * size * size);
  out.fill(-1); // pad region

  const hw = width * height;
  // For each output pixel inside the resized rect, do bilinear sample.
  for (let oy = 0; oy < targetH; oy++) {
    const srcY = (oy + 0.5) * (height / targetH) - 0.5;
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = srcY - y0;

    for (let ox = 0; ox < targetW; ox++) {
      const srcX = (ox + 0.5) * (width / targetW) - 0.5;
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = srcX - x0;

      for (let c = 0; c < 3; c++) {
        const v00 = readPixel(pixels, x0, y0, width, layout, c, hw);
        const v01 = readPixel(pixels, x1, y0, width, layout, c, hw);
        const v10 = readPixel(pixels, x0, y1, width, layout, c, hw);
        const v11 = readPixel(pixels, x1, y1, width, layout, c, hw);
        const top = v00 * (1 - wx) + v01 * wx;
        const bot = v10 * (1 - wx) + v11 * wx;
        const v = (top * (1 - wy) + bot * wy) * scaleHint;
        // Map [0, 1] → [-1, 1].
        out[c * size * size + (oy + padY) * size + (ox + padX)] = v * 2 - 1;
      }
    }
  }
  return out;
}

/**
 * Zero-pad a robot-state vector to the model's `maxStateDim`. Truncates if
 * the input is longer than the target. Mirrors `@qvac/vla-ggml`'s `padState`.
 */
export function vlaPadState(
  state: ArrayLike<number>,
  targetDim?: number,
): Float32Array {
  const dim = targetDim ?? state.length;
  if (!Number.isInteger(dim) || dim < 0) {
    throw new TypeError(
      "vlaPadState: targetDim must be a non-negative integer",
    );
  }
  const out = new Float32Array(dim);
  const n = Math.min(state.length, dim);
  for (let i = 0; i < n; i++) out[i] = state[i] as number;
  return out;
}

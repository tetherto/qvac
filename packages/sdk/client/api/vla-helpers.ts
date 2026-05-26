/**
 * Pure-JS helpers for preparing VLA inference inputs on the client side.
 *
 * Mirrors `preprocessImage` / `padState` / `DEFAULT_IMAGE_SIZE` from
 * `@qvac/vla-ggml/addon.js`. Kept inlined (not re-exported from the addon)
 * so the SDK's client surface never loads the addon's native binding —
 * consumers running under Node / Bun / Expo without VLA prebuilds can still
 * use the SDK to drive a remote VLA worker.
 *
 * This file is a verbatim port of the addon's JS implementation; keep them
 * in sync so the wire-format tensors stay byte-identical regardless of
 * where preprocessing runs (consumer process vs worker vs addon).
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
  if (pixels instanceof Uint8Array) return 1 / 255;
  // Float/Number arrays: scan a small window to decide whether it's [0,255] or [0,1].
  const limit = Math.min(pixels.length, 256);
  let maxVal = 0;
  for (let i = 0; i < limit; i++) {
    const v = pixels[i] as number;
    if (v > maxVal) maxVal = v;
  }
  return maxVal > 1.001 ? 1 / 255 : 1;
}

/**
 * Resize + letterbox + normalize a camera frame to `(3, size, size)` Float32
 * in `[-1, 1]`. Drop-in equivalent of `@qvac/vla-ggml`'s `preprocessImage`.
 *
 * Letterbox places the resized content at the **bottom-right** with padding
 * at top/left (`padLeft = size - newW`, `padTop = size - newH`), matching
 * the reference smolvla.cpp behavior.
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

  const normalize =
    opts.scale === 1 || opts.scale === 1 / 255
      ? opts.scale
      : detectScale(pixels);

  // Letterbox target size (aspect-ratio preserving).
  const ratio = Math.max(width / size, height / size);
  const newW = Math.max(1, Math.floor(width / ratio));
  const newH = Math.max(1, Math.floor(height / ratio));
  const padLeft = size - newW;
  const padTop = size - newH;
  const xScale = width / newW;
  const yScale = height / newH;

  // Output starts at -1 so the pad region is already in [-1, 1] and we only
  // need to overwrite the (newH × newW) inner region with the resized content.
  const out = new Float32Array(3 * size * size);
  out.fill(-1);

  const planeStride = size * size;
  const widthHeight = width * height;

  for (let yy = 0; yy < newH; yy++) {
    const yIn = (yy + 0.5) * yScale - 0.5;
    const y0 = Math.max(0, Math.floor(yIn));
    const y1 = Math.min(height - 1, y0 + 1);
    const dy = Math.min(1, Math.max(0, yIn - y0));
    const dyInv = 1 - dy;
    const outY = yy + padTop;

    for (let xx = 0; xx < newW; xx++) {
      const xIn = (xx + 0.5) * xScale - 0.5;
      const x0 = Math.max(0, Math.floor(xIn));
      const x1 = Math.min(width - 1, x0 + 1);
      const dx = Math.min(1, Math.max(0, xIn - x0));
      const dxInv = 1 - dx;
      const outX = xx + padLeft;

      const w00 = dxInv * dyInv;
      const w10 = dx * dyInv;
      const w01 = dxInv * dy;
      const w11 = dx * dy;

      const outIdx = outY * size + outX;

      if (layout === "hwc") {
        const i00 = (y0 * width + x0) * 3;
        const i10 = (y0 * width + x1) * 3;
        const i01 = (y1 * width + x0) * 3;
        const i11 = (y1 * width + x1) * 3;
        for (let c = 0; c < 3; c++) {
          const v =
            (pixels[i00 + c] as number) * w00 +
            (pixels[i10 + c] as number) * w10 +
            (pixels[i01 + c] as number) * w01 +
            (pixels[i11 + c] as number) * w11;
          // Apply scale and shift into [-1, 1] in one fused multiply-add.
          out[c * planeStride + outIdx] = v * normalize * 2 - 1;
        }
      } else {
        for (let c = 0; c < 3; c++) {
          const plane = c * widthHeight;
          const v =
            (pixels[plane + y0 * width + x0] as number) * w00 +
            (pixels[plane + y0 * width + x1] as number) * w10 +
            (pixels[plane + y1 * width + x0] as number) * w01 +
            (pixels[plane + y1 * width + x1] as number) * w11;
          out[c * planeStride + outIdx] = v * normalize * 2 - 1;
        }
      }
    }
  }

  return out;
}

/**
 * Zero-pad a state vector to `targetDim`. Extra entries are zero-initialised;
 * input longer than `targetDim` raises. Mirrors how smolvla.cpp expects the
 * state tensor (`max_state_dim` = 32 by default).
 */
export function vlaPadState(
  state: ArrayLike<number>,
  targetDim: number = 32,
): Float32Array {
  if (!Number.isInteger(targetDim) || targetDim <= 0) {
    throw new TypeError(
      "vlaPadState: targetDim must be a positive integer",
    );
  }
  if (state.length > targetDim) {
    throw new RangeError(
      `vlaPadState: input length ${state.length} exceeds targetDim ${targetDim}`,
    );
  }
  const out = new Float32Array(targetDim);
  for (let i = 0; i < state.length; i++) out[i] = state[i] as number;
  return out;
}

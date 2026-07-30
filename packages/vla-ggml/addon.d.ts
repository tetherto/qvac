export declare const DEFAULT_IMAGE_SIZE = 512;
export interface PreprocessImageOptions {
    size?: number;
    layout?: "hwc" | "chw";
    /**
     * Pixel-range hint that skips the [0,255] vs [0,1] auto-detection
     * heuristic. Pass `1` if pixels are already in [0,1] (no rescale),
     * pass `1/255` if pixels are in [0,255] (rescale to [0,1]). Anything
     * else (including the literal `'auto'`) falls back to the heuristic.
     * Typed as `number | 'auto'` because TS literal types can't represent
     * `1/255` directly.
     */
    scale?: number | "auto";
}
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
 * @param pixels - source pixels
 * @param width - source width
 * @param height - source height
 * @param opts
 *   `scale` skips the [0,255] vs [0,1] heuristic when the caller knows the
 *   range (`1` = pixels already in [0,1], `1/255` = pixels in [0,255]).
 */
export declare function preprocessImage(pixels: Float32Array | Uint8Array | number[], width: number, height: number, opts?: PreprocessImageOptions): Float32Array;
/**
 * Zero-pad a state vector to `targetDim`. Extra entries are zero-initialised;
 * input longer than `targetDim` raises. Mirrors how smolvla.cpp expects the
 * state tensor (`max_state_dim` = 32 by default).
 */
export declare function padState(state: ArrayLike<number>, targetDim?: number): Float32Array;

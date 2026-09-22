import QvacLogger = require('@qvac/logging');
import { type QvacResponse } from '@qvac/infer-base';
import { ActionFlag } from './addon';
export { ActionFlag };
export type WalkKey = 'W' | 'A' | 'S' | 'D' | 'I' | 'J' | 'K' | 'L';
/**
 * Keys held during a block: a keys object (`{ W: true }`), an array
 * (`['W', 'J']`), or a raw 8-bit mask — a bitwise OR of `ActionFlag` values
 * (`ActionFlag.W | ActionFlag.L`; bit 0..7 = W,A,S,D,I,J,K,L).
 */
export type WalkKeys = number | readonly string[] | Readonly<Record<string, unknown>>;
/** File paths for an ABot-World walk session. All paths must be absolute. */
export interface WorldFiles {
    /** ABot-World DiT GGUF (F16 or Q8_0). */
    model: string;
    /** taew2_2 GGUF (streaming pixel decoder). */
    taehv: string;
    /**
     * Scene pack safetensors (prompt embeds, first-frame latents, reference
     * latents). Consumed by walks; produced by `createScene()`.
     */
    scene: string;
}
export interface WorldConfig {
    threads?: number;
    seed?: number;
    backend?: string;
    /** Latent frames the DiT denoises per step. 0 = model default (3). */
    numFramePerBlock?: number;
    /** History attention window in latent frames. 0 = engine default (8). */
    localAttnSize?: number;
    offloadParamsToCpu?: boolean;
    backendsDir?: string;
    /**
     * Frame encoding: 0 = lossless PNG; 1..100 = JPEG at that quality on the
     * standard JPEG scale (higher = better quality / larger frames; 85 is a
     * good remote-streaming value).
     */
    frameJpegQuality?: number;
    /**
     * Per-layer history KV cache (~3.7x fewer frame-passes per block). The
     * engine validates it against localAttnSize at load and fails fast on a
     * window the compiled KV ring cannot hold.
     */
    kvCache?: boolean;
    /** Per-stage timing logs from the native session. */
    profile?: boolean;
    [key: string]: string | number | boolean | undefined;
}
export interface WorldStableDiffusionArgs {
    files: WorldFiles;
    config?: WorldConfig;
    logger?: QvacLogger | Console | null;
    opts?: {
        stats?: boolean;
    };
}
export interface WorldSceneParams {
    /** Scene prompt (encoded verbatim; reference demos prefix "| unknown | "). */
    prompt: string;
    /** First frame, PNG or JPEG bytes. */
    image: Uint8Array;
    /** umT5-XXL model path (absolute). */
    t5: string;
    /** Wan2.2 VAE model path (absolute). */
    vae: string;
    /** Destination scene pack path (absolute). */
    output: string;
    /** Multiples of 32. Default 832. */
    width?: number;
    /** Multiples of 32. Default 480. */
    height?: number;
}
/**
 * ABot-World interactive walk session.
 *
 * ABot-World is a causal world model: it generates video block-by-block under
 * per-block keyboard actions instead of one batch call. A session holds the
 * DiT + taehv decoder and a fixed scene pack; each `step()` generates the next
 * block of the walk and streams its decoded frames as PNG byte arrays (or
 * JPEG when `config.frameJpegQuality` is 1..100).
 *
 * ```js
 * const WorldStableDiffusion = require('@qvac/diffusion-cpp/world')
 * const world = new WorldStableDiffusion({
 *   files: { model: ditGguf, taehv: taehvGguf, scene: scenePack },
 *   config: { threads: 8, seed: 42, kvCache: true }
 * })
 * await world.load()
 * const response = await world.step({ W: true }) // walk forward one block
 * await response.onUpdate((data) => {
 *   if (data instanceof Uint8Array) framePngs.push(data)
 * }).await()
 * await world.unload()
 * ```
 */
export default class WorldStableDiffusion {
    opts: {
        stats?: boolean;
    };
    logger: QvacLogger;
    state: {
        configLoaded: boolean;
    };
    private readonly _files;
    private readonly _config;
    private readonly _job;
    private readonly _run;
    private addon;
    private _hasActiveResponse;
    constructor({ files, config, logger, opts }: WorldStableDiffusionArgs);
    load(): Promise<void>;
    private _load;
    private _createAddon;
    private _addonOutputCallback;
    /**
     * Generate the next block of the walk.
     *
     * Output stream (via `QvacResponse.onUpdate(data)`):
     *   - `Uint8Array` — one decoded RGB frame as PNG (several per block), or
     *     JPEG when `config.frameJpegQuality` is 1..100
     *   - `string`     — progress JSON `{"step":N,"frames":M,"elapsed_ms":T}`
     *
     * @param keys - Keys held during this block: a keys object `{ W: true }`,
     *        an array `['W']`, or a raw 8-bit mask built from `ActionFlag`
     *        values (bit 0..7 = W,A,S,D,I,J,K,L).
     *        Omit for no keys (idle).
     */
    step(keys?: WalkKeys): Promise<QvacResponse>;
    /**
     * Create a scene pack natively: umT5-XXL encodes the prompt, the Wan2.2 VAE
     * encodes the first-frame image (cover-scaled and center-cropped to
     * width x height), reference slots are zero-filled, and the pack is written
     * to `output` — loadable via `files.scene` for a walk session. Standalone:
     * works before load() (the session loads its own encoders per job and
     * frees them after).
     *
     * Output stream (via `QvacResponse.onUpdate(data)`):
     *   - `string` — completion JSON `{"scene":"<path>","elapsed_ms":T}`
     */
    createScene(params: WorldSceneParams): Promise<QvacResponse>;
    private _createSceneInternal;
    private _stepInternal;
    cancel(): Promise<void>;
    unload(): Promise<void>;
    getState(): {
        configLoaded: boolean;
    };
}

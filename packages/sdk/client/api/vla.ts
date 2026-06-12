import {
  type VlaClientRunParams,
  type VlaClientRunResult,
  type VlaHparams,
  type VlaHparamsRequest,
  type VlaHparamsResponse,
  type VlaRunRequest,
  type VlaRunResponse,
  vlaHparamsResponseSchema,
  vlaRunResponseSchema,
} from "@/schemas";
import { decodeBase64, encodeBase64 } from "@/utils/encoding";
import { invokePlugin } from "./invoke-plugin";

const VLA_RUN_HANDLER = "vlaRun";
const VLA_HPARAMS_HANDLER = "vlaHparams";

function bytesOf(arr: Float32Array | Int32Array | Uint8Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function f32FromBase64(b64: string): Float32Array {
  const bytes = decodeBase64(b64);
  // base64 round-trip produces a fresh Uint8Array whose buffer starts at 0
  // and isn't shared, so the underlying ArrayBuffer is safe to reinterpret.
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Run VLA inference on a loaded model (SmolVLA or π₀.₅) and return the
 * produced action chunk plus per-stage timings.
 *
 * @param params - Inference inputs.
 * @param params.modelId - Identifier of the loaded VLA model (returned by
 *   `loadModel({ modelType: "vla", ... })`).
 * @param params.images - The preprocessed camera frames; each is a
 *   `Float32Array` of length `3 * imgWidth * imgHeight` in CHW layout, range
 *   `[-1, 1]`. Pass exactly `hparams.numCameras` frames (2 for SmolVLA, 3
 *   for π₀.₅). Use the addon's `preprocessImage()` (re-exported as
 *   `vlaPreprocessImage`) to produce them.
 * @param params.imgWidth - Width of each preprocessed image; must equal
 *   `hparams.visionImageSize`.
 * @param params.imgHeight - Height of each preprocessed image; must equal
 *   `hparams.visionImageSize`.
 * @param params.state - Robot end-effector / gripper state. For
 *   continuous-state models (SmolVLA) pad to `hparams.maxStateDim` with
 *   `vlaPadState`. For discrete-state models (π₀.₅,
 *   `hparams.stateInputMode === 'discrete'`) the state is tokenised into the
 *   prompt and this buffer is ignored — pass an empty `Float32Array(0)`.
 * @param params.tokens - Tokenized instruction (`Int32Array` of length
 *   `hparams.tokenizerMaxLength`). Tokenize on the consumer side with the
 *   model's tokenizer (SmolVLM2 for SmolVLA, PaliGemma/Gemma for π₀.₅).
 * @param params.mask - Token attention mask (`Uint8Array` matching `tokens`).
 * @param params.noise - Optional seeded noise prior
 *   (`Float32Array` of length `hparams.chunkSize * hparams.maxActionDim`).
 *   When omitted the addon samples its own prior.
 * @returns A `VlaClientRunResult` with the produced `actions` Float32Array
 *   (length `chunkSize * actionDim`), the corresponding `chunkSize` /
 *   `actionDim` returned by the addon, and optional per-stage `stats`.
 *
 * @example
 * ```typescript
 * import { loadModel, vla, vlaPreprocessImage, vlaPadState, vlaHparams } from "@qvac/sdk";
 *
 * const modelId = await loadModel({ modelSrc: "/path/to/smolvla.gguf", modelType: "vla" });
 * const { hparams } = await vlaHparams({ modelId });
 * const size = hparams.visionImageSize;
 * const front = vlaPreprocessImage(frontPixels, frontW, frontH, { size });
 * const wrist = vlaPreprocessImage(wristPixels, wristW, wristH, { size });
 * const state = vlaPadState(robotState, hparams.maxStateDim);
 * const tokens = new Int32Array(hparams.tokenizerMaxLength);
 * const mask = new Uint8Array(hparams.tokenizerMaxLength);
 * // ...tokenize the instruction into tokens/mask...
 * const { actions } = await vla({
 *   modelId, images: [front, wrist], imgWidth: size, imgHeight: size,
 *   state, tokens, mask,
 * });
 * ```
 */
export async function vla(
  params: VlaClientRunParams,
): Promise<VlaClientRunResult> {
  const wireRequest: VlaRunRequest = {
    type: "vlaRun",
    modelId: params.modelId,
    images: params.images.map((img) => encodeBase64(bytesOf(img))),
    imgWidth: params.imgWidth,
    imgHeight: params.imgHeight,
    state: encodeBase64(bytesOf(params.state)),
    tokens: encodeBase64(bytesOf(params.tokens)),
    mask: encodeBase64(bytesOf(params.mask)),
    ...(params.noise !== undefined && {
      noise: encodeBase64(bytesOf(params.noise)),
    }),
  };

  const result = await invokePlugin<VlaRunResponse, VlaRunRequest>({
    modelId: params.modelId,
    handler: VLA_RUN_HANDLER,
    params: wireRequest,
  });

  const parsed = vlaRunResponseSchema.parse(result);
  return {
    actions: f32FromBase64(parsed.actions),
    actionDim: parsed.actionDim,
    chunkSize: parsed.chunkSize,
    ...(parsed.stats && { stats: parsed.stats }),
  };
}

/**
 * Fetch the loaded VLA model's hyperparameters and the active ggml backend
 * name. Useful to size token / state / noise buffers before calling `vla()`.
 *
 * @param params - Identifier of the loaded VLA model.
 * @returns The model's hparams and the human-readable backend name
 *   (`"CPU"` / `"Vulkan"` / `"Metal"` / `"OpenCL"` / `null` if the addon
 *   has not surfaced one).
 */
export async function vlaHparams(params: {
  modelId: string;
}): Promise<{ hparams: VlaHparams; backendName: string | null }> {
  const wireRequest: VlaHparamsRequest = {
    type: "vlaHparams",
    modelId: params.modelId,
  };
  const result = await invokePlugin<VlaHparamsResponse, VlaHparamsRequest>({
    modelId: params.modelId,
    handler: VLA_HPARAMS_HANDLER,
    params: wireRequest,
  });
  return vlaHparamsResponseSchema.parse(result);
}

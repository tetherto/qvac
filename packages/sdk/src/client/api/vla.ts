import {
  type VlaClientRunParams,
  type VlaClientRunResult,
  type VlaEmbodimentSelection,
  type VlaHparams,
  type VlaHparamsRequest,
  type VlaHparamsResponse,
  type VlaRunRequest,
  type VlaRunResponse,
  type VlaSetEmbodimentRequest,
  type VlaSetEmbodimentResponse,
  vlaHparamsResponseSchema,
  vlaRunResponseSchema,
  vlaSetEmbodimentResponseSchema
} from '@qvac/inference/surface'
import { decodeBase64, encodeBase64 } from '@/utils/encoding'
import { invokePlugin } from './invoke-plugin'

const VLA_RUN_HANDLER = 'vlaRun'
const VLA_HPARAMS_HANDLER = 'vlaHparams'
const VLA_SET_EMBODIMENT_HANDLER = 'vlaSetEmbodiment'

function bytesOf(arr: Float32Array | Int32Array | Uint8Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
}

function f32FromBase64(b64: string): Float32Array {
  const bytes = decodeBase64(b64)
  // base64 round-trip produces a fresh Uint8Array whose buffer starts at 0
  // and isn't shared, so the underlying ArrayBuffer is safe to reinterpret.
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

/**
 * Run VLA inference on a loaded model (SmolVLA, π₀.₅, or GR00T) and return the
 * produced action chunk plus per-stage timings.
 */
export async function vla(params: VlaClientRunParams): Promise<VlaClientRunResult> {
  const wireRequest: VlaRunRequest = {
    type: 'vlaRun',
    modelId: params.modelId,
    images: params.images.map((img) => encodeBase64(bytesOf(img))),
    imgWidth: params.imgWidth,
    imgHeight: params.imgHeight,
    state: encodeBase64(bytesOf(params.state)),
    tokens: encodeBase64(bytesOf(params.tokens)),
    mask: encodeBase64(bytesOf(params.mask)),
    ...(params.noise !== undefined && {
      noise: encodeBase64(bytesOf(params.noise))
    })
  }

  const result = await invokePlugin<VlaRunResponse, VlaRunRequest>({
    modelId: params.modelId,
    handler: VLA_RUN_HANDLER,
    params: wireRequest
  })

  const parsed = vlaRunResponseSchema.parse(result)
  return {
    actions: f32FromBase64(parsed.actions),
    actionDim: parsed.actionDim,
    chunkSize: parsed.chunkSize,
    ...(parsed.stats && { stats: parsed.stats })
  }
}

/**
 * Fetch the loaded VLA model's hyperparameters and the active ggml backend
 * name. Useful to size token / state / noise buffers before calling `vla()`.
 */
export async function vlaHparams(params: {
  modelId: string
}): Promise<{ hparams: VlaHparams; backendName: string | null }> {
  const wireRequest: VlaHparamsRequest = {
    type: 'vlaHparams',
    modelId: params.modelId
  }
  const result = await invokePlugin<VlaHparamsResponse, VlaHparamsRequest>({
    modelId: params.modelId,
    handler: VLA_HPARAMS_HANDLER,
    params: wireRequest
  })
  return vlaHparamsResponseSchema.parse(result)
}

/**
 * Switch a loaded multi-embodiment GR00T model to another embodiment shipped
 * in the same GGUF — no reload, only that embodiment's weight rows are re-read.
 */
export async function vlaSetEmbodiment(params: {
  modelId: string
  embodiment: VlaEmbodimentSelection
}): Promise<{ hparams: VlaHparams }> {
  const wireRequest: VlaSetEmbodimentRequest = {
    type: 'vlaSetEmbodiment',
    modelId: params.modelId,
    embodiment: params.embodiment
  }
  const result = await invokePlugin<VlaSetEmbodimentResponse, VlaSetEmbodimentRequest>({
    modelId: params.modelId,
    handler: VLA_SET_EMBODIMENT_HANDLER,
    params: wireRequest
  })
  return vlaSetEmbodimentResponseSchema.parse(result)
}

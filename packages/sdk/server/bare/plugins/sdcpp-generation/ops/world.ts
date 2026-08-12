import { promises as fsPromises } from 'bare-fs'
import WorldStableDiffusion from '@qvac/diffusion-cpp/world'
import { getServerLogger } from '@/logging'
import { getModelEntry, getModel } from '@/server/bare/registry/model-registry'
import { getRequestRegistry, withRequestContext } from '@/server/bare/runtime'
import { generateServerRequestId } from '@/server/bare/runtime/request-id'
import {
  ModelOperationNotSupportedError,
  PluginRequestValidationFailedError
} from '@/utils/errors-server'
import { ModelType } from '@/schemas'
import type {
  WorldSceneRequest,
  WorldSceneStats,
  WorldSceneStreamResponse,
  WorldStats,
  WorldStepRequest,
  WorldStepStreamResponse
} from '@/schemas/sdcpp-config'

// Session stats delivered by the addon on the terminal event (`opts.stats`).
// The walk addon keeps these subpath-local, so mirror the shapes here.
interface WorldRuntimeStats {
  modelLoadMs?: number
  stepMs?: number
  totalStepMs?: number
  totalSteps?: number
  totalFrames?: number
  frames?: number
  width?: number
  height?: number
  actionMask?: number
}

interface WorldSceneRuntimeStats {
  sceneCreateMs?: number
  width?: number
  height?: number
}

interface ResponseWithStats<Stats> {
  stats?: Stats
}

interface WorldModelInfo {
  scenePath: string
  t5Path?: string
  vaePath?: string
}

// Load-time facts the ops need that the addon instance does not expose:
// where the scene pack lives (worldCreateScene writes only there — output
// paths are never accepted over the wire) and which scene encoders were
// resolved at loadModel. Same registration pattern as ops/video.ts's
// markLtxVideoModel.
const worldModelInfo = new WeakMap<WorldStableDiffusion, WorldModelInfo>()

export function markWorldModel(model: WorldStableDiffusion, info: WorldModelInfo) {
  worldModelInfo.set(model, info)
}

async function sceneFileExists(scenePath: string) {
  try {
    await fsPromises.stat(scenePath)
    return true
  } catch {
    return false
  }
}

/**
 * The SDK loads models eagerly at loadModel(), but a walk session's native
 * load requires the scene pack file, which may only be written later by
 * worldCreateScene(). Shadow `load()` on the instance so the eager load
 * becomes a no-op while the pack is absent; worldStep() calls `load()`
 * again once the pack exists (the addon's load is idempotent).
 */
export function installDeferredWorldLoad(model: WorldStableDiffusion) {
  const nativeLoad = model.load.bind(model)
  async function load() {
    const info = worldModelInfo.get(model)
    if (info && !(await sceneFileExists(info.scenePath))) return
    await nativeLoad()
  }
  Object.assign(model, { load })
}

// The diffusion plugin instantiates `WorldStableDiffusion` only when the
// model is loaded with `modelConfig.mode === "world"`. Every other mode has
// no walk-session shape, so refuse upfront with a structured error rather
// than letting a native-addon error propagate.
function asWorldModel(model: unknown, modelId: string): WorldStableDiffusion {
  if (model instanceof WorldStableDiffusion) {
    return model
  }

  const entry = getModelEntry(modelId)
  const modelType = entry && !entry.isDelegated ? entry.local.modelType : ModelType.sdcppGeneration
  throw new ModelOperationNotSupportedError(modelId, modelType, 'world', ['diffusion'], [])
}

function getWorldInfo(model: WorldStableDiffusion, method: string): WorldModelInfo {
  const info = worldModelInfo.get(model)
  if (!info) {
    // Unreachable through the plugin (createModel always marks the model);
    // guards direct registrations in tests.
    throw new PluginRequestValidationFailedError(
      method,
      'world model is missing its load-time info'
    )
  }
  return info
}

export async function* worldStep(
  request: WorldStepRequest
): AsyncGenerator<WorldStepStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateServerRequestId(),
    kind: 'diffusion',
    modelId: request.modelId
  })
  const requestLogger = withRequestContext(getServerLogger(), ctx)
  const model = asWorldModel(getModel(request.modelId), request.modelId)
  const info = getWorldInfo(model, 'worldStep')

  if (!(await sceneFileExists(info.scenePath))) {
    throw new PluginRequestValidationFailedError(
      'worldStep',
      `scene pack not found at ${info.scenePath} — create one first with worldCreateScene({ ... }) or point modelConfig.world.scenePack at an existing pack.`
    )
  }
  // No-op once the session is resident; performs the deferred native load on
  // the first step after the scene pack appears.
  await model.load()

  const onAbort = () => {
    model.cancel().catch((err: unknown) => {
      requestLogger.warn(
        `[cancel] model.cancel() rejected during abort for modelId=${request.modelId}: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  if (ctx.signal.aborted) onAbort()
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener('abort', onAbort)
  })

  const response = await model.step(request.keys ?? 0)

  let outputIndex = 0

  for await (const chunk of response.iterate()) {
    if (ctx.signal.aborted) break
    if (chunk instanceof Uint8Array) {
      yield {
        type: 'worldStep',
        data: Buffer.from(chunk).toString('base64'),
        outputIndex: outputIndex++
      }
    } else if (typeof chunk === 'string') {
      try {
        const tick = JSON.parse(chunk) as Record<string, unknown>
        if ('step' in tick) {
          yield {
            type: 'worldStep',
            step: tick['step'] as number,
            frames: tick['frames'] as number,
            elapsedMs: tick['elapsed_ms'] as number
          }
        }
      } catch {
        // Non-JSON string output — skip
      }
    }
  }

  const responseWithStats = response as unknown as ResponseWithStats<WorldRuntimeStats>
  yield {
    type: 'worldStep',
    done: true,
    stats: toWorldStats(responseWithStats.stats)
  }
}

function toWorldStats(stats: WorldRuntimeStats | undefined): WorldStats | undefined {
  if (!stats) return undefined
  return stats
}

export async function* worldCreateScene(
  request: WorldSceneRequest
): AsyncGenerator<WorldSceneStreamResponse> {
  await using ctx = await getRequestRegistry().begin({
    requestId: request.requestId ?? generateServerRequestId(),
    kind: 'diffusion',
    modelId: request.modelId
  })
  const model = asWorldModel(getModel(request.modelId), request.modelId)
  const info = getWorldInfo(model, 'worldCreateScene')

  if (!info.t5Path || !info.vaePath) {
    throw new PluginRequestValidationFailedError(
      'worldCreateScene',
      'scene creation needs the encoders resolved at load time — load the model with modelConfig.t5XxlModelSrc (umT5-XXL) and modelConfig.vaeModelSrc (Wan 2.2 VAE).'
    )
  }

  // The reference pipeline conditions prompts behind a '| unknown |' prefix;
  // apply it for callers who pass a bare description (mirrors the addon's
  // browser demo).
  const prompt = request.prompt.startsWith('| unknown |')
    ? request.prompt
    : `| unknown | ${request.prompt}`

  // Scene creation is standalone: it loads its own encoders per call and does
  // not require (or perform) the walk-session load. The pack is written to
  // the load-time scenePack path only — never to a caller-supplied path.
  const response = await model.createScene({
    prompt,
    image: new Uint8Array(Buffer.from(request.image, 'base64')),
    t5: info.t5Path,
    vae: info.vaePath,
    output: info.scenePath,
    ...(request.width !== undefined && { width: request.width }),
    ...(request.height !== undefined && { height: request.height })
  })

  for await (const chunk of response.iterate()) {
    if (ctx.signal.aborted) break
    // The scene job emits a single completion JSON string; its contents are
    // covered by the terminal stats below, so drain without yielding.
    void chunk
  }

  const responseWithStats = response as unknown as ResponseWithStats<WorldSceneRuntimeStats>
  yield {
    type: 'worldCreateScene',
    done: true,
    stats: toWorldSceneStats(responseWithStats.stats)
  }
}

function toWorldSceneStats(stats: WorldSceneRuntimeStats | undefined): WorldSceneStats | undefined {
  if (!stats) return undefined
  return stats
}

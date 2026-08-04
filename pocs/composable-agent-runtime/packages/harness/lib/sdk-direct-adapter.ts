import type {
  SdkImageGenerationInput,
  SdkImageGenerationResult,
  SdkImageProgress,
  SdkRuntimeEvent,
  SdkRuntimePort
} from './sdk-runtime-port.ts'
import type { HarnessToolSchema } from './tool-broker.ts'
import type { HarnessJsonValue } from './types.ts'

interface SdkCompletionEvent {
  readonly type:
    | 'contentDelta'
    | 'thinkingDelta'
    | 'rawDelta'
    | 'toolCall'
    | 'toolError'
    | 'completionStats'
    | 'completionDone'
  readonly text?: string
  readonly call?: {
    readonly id: string
    readonly name: string
    readonly arguments: Readonly<Record<string, HarnessJsonValue>>
    readonly raw?: string
  }
  readonly error?: { readonly message: string }
  readonly raw?: { readonly fullText: string }
  readonly stats?: Readonly<Record<string, number | string | undefined>>
  readonly stopReason?: 'eos' | 'length' | 'stopSequence' | 'cancelled' | 'error'
}

interface ModelLogger {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
}

type DiffusionPrediction =
  | 'auto'
  | 'eps'
  | 'v'
  | 'edm_v'
  | 'flow'
  | 'flux2_flow'

interface DiffusionSdkRun {
  readonly progressStream: AsyncIterable<SdkImageProgress>
  readonly outputs: Promise<Uint8Array[]>
  readonly stats: Promise<Readonly<Record<string, number | string | undefined>> | undefined>
}

interface ActiveImageGeneration {
  readonly requestId: string
  cancelled: boolean
  settled?: Promise<SdkImageGenerationResult>
}

interface SdkModule {
  loadModel(input: {
    readonly modelSrc: string
    readonly modelType: string
    readonly modelConfig?: {
      readonly tools?: boolean
      readonly ctx_size?: number
      readonly prediction?: DiffusionPrediction
    }
    readonly logger?: ModelLogger
  }): Promise<string>
  completion(input: {
    readonly modelId: string
    readonly history: readonly { readonly role: string; readonly content: string }[]
    readonly stream: true
    readonly tools?: readonly HarnessToolSchema[]
    readonly generationParams?: {
      readonly predict?: number
      readonly reasoning_budget?: number
    }
  }): { readonly requestId: string; readonly events: AsyncIterable<SdkCompletionEvent> }
  diffusion(input: {
    readonly modelId: string
    readonly prompt: string
    readonly negative_prompt?: string
    readonly width: number
    readonly height: number
    readonly steps?: number
    readonly seed?: number
  }): DiffusionSdkRun
  cancel(
    input:
      | { readonly requestId: string }
      | { readonly modelId: string; readonly kind: 'diffusion' }
  ): Promise<void>
  unloadModel(input: {
    readonly modelId: string
    readonly clearStorage: false
    readonly autoClose: false
  }): Promise<void>
  heartbeat(): Promise<object>
  close(): Promise<void>
}

export interface CreateSdkDirectAdapterOptions {
  readonly logger?: ModelLogger
  readonly diffusion?: {
    readonly model: string
    readonly modelConfig?: {
      readonly prediction?: DiffusionPrediction
    }
  }
}

export async function createSdkDirectAdapter({
  logger,
  diffusion
}: CreateSdkDirectAdapterOptions = {}): Promise<SdkRuntimePort> {
  const [{ close, plugins }, { llmPlugin }, { diffusionPlugin }] = await Promise.all([
    import('@qvac/sdk'),
    import('@qvac/sdk/llamacpp-completion/plugin'),
    import('@qvac/sdk/sdcpp-generation/plugin')
  ])
  const sdk = {
    ...plugins([llmPlugin, diffusionPlugin]),
    close
  } as SdkModule
  let closed = false
  let diffusionModelPromise: Promise<string> | undefined
  let diffusionModelId: string | undefined
  let activeImage: ActiveImageGeneration | undefined

  function loadDiffusionModel() {
    if (!diffusion) {
      throw new Error('diffusion model is not configured for the shared SDK runtime')
    }
    diffusionModelPromise ??= sdk.loadModel({
      modelSrc: diffusion.model,
      modelType: 'sdcpp-generation',
      ...(diffusion.modelConfig
        ? { modelConfig: diffusion.modelConfig }
        : {}),
      logger
    }).then(
      (modelId) => {
        diffusionModelId = modelId
        return modelId
      },
      (error) => {
        diffusionModelPromise = undefined
        throw error
      }
    )
    return diffusionModelPromise
  }

  async function cancelImage(
    image: ActiveImageGeneration
  ) {
    image.cancelled = true
    if (diffusionModelId) {
      await sdk.cancel({
        modelId: diffusionModelId,
        kind: 'diffusion'
      })
    }
  }

  function assertImageActive(
    image: ActiveImageGeneration,
    signal: SdkImageGenerationInput['signal']
  ) {
    if (image.cancelled || signal.aborted) {
      throw new Error('diffusion generation cancelled')
    }
  }

  async function runImageGeneration(
    input: SdkImageGenerationInput,
    image: ActiveImageGeneration
  ): Promise<SdkImageGenerationResult> {
    const abort = () => {
      image.cancelled = true
      if (diffusionModelId) void cancelImage(image).catch(() => {})
    }
    if (input.signal.aborted) abort()
    else input.signal.addEventListener('abort', abort, { once: true })

    try {
      const modelId = await loadDiffusionModel()
      assertImageActive(image, input.signal)
      const run = sdk.diffusion({
        modelId,
        prompt: input.prompt,
        ...(input.negativePrompt !== undefined
          ? { negative_prompt: input.negativePrompt }
          : {}),
        width: input.width,
        height: input.height,
        ...(input.steps !== undefined ? { steps: input.steps } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {})
      })
      let progressError: Error | undefined
      const drainProgress = (async () => {
        for await (const progress of run.progressStream) {
          if (image.cancelled || input.signal.aborted) continue
          try {
            await input.onProgress(progress)
          } catch (error) {
            progressError ??= error instanceof Error
              ? error
              : new Error(String(error))
          }
        }
      })()
      const [outputs, stats, progress] = await Promise.allSettled([
        run.outputs,
        run.stats,
        drainProgress
      ])
      assertImageActive(image, input.signal)
      if (outputs.status === 'rejected') throw outputs.reason
      if (stats.status === 'rejected') throw stats.reason
      if (progress.status === 'rejected') throw progress.reason
      if (progressError) throw progressError
      const output = outputs.status === 'fulfilled'
        ? outputs.value[0]
        : undefined
      if (!output) throw new Error('diffusion generation returned no image')
      return {
        status: 'success',
        image: output,
        stats: boundedStats(
          stats.status === 'fulfilled'
            ? stats.value
            : undefined
        )
      }
    } catch (error) {
      if (image.cancelled || input.signal.aborted) {
        throw new Error('diffusion generation cancelled')
      }
      throw error
    } finally {
      input.signal.removeEventListener('abort', abort)
    }
  }

  return {
    async loadModel({ model, toolSupport }) {
      const modelId = await sdk.loadModel({
        modelSrc: model,
        modelType: 'llamacpp-completion',
        ...(toolSupport
          ? { modelConfig: { tools: true, ctx_size: 4096 } }
          : {}),
        logger
      })
      return { modelId }
    },
    completion({ modelId, messages, tools }) {
      const run = sdk.completion({
        modelId,
        history: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
        ...(tools ? { tools } : {}),
        generationParams: {
          predict: 128,
          reasoning_budget: 0
        }
      })
      return {
        requestId: run.requestId,
        events: sdkEvents(run.events)
      }
    },
    generateImage(input) {
      if (closed) return Promise.reject(new Error('shared SDK runtime is closed'))
      if (activeImage) {
        return Promise.resolve({
          status: 'busy',
          message: 'diffusion generation is already active'
        })
      }
      const image: ActiveImageGeneration = {
        requestId: input.requestId,
        cancelled: false
      }
      activeImage = image
      const settled = runImageGeneration(input, image).finally(() => {
        if (activeImage === image) activeImage = undefined
      })
      image.settled = settled
      return settled
    },
    async cancel({ requestId }) {
      if (activeImage?.requestId === requestId) {
        await cancelImage(activeImage)
        return
      }
      await sdk.cancel({ requestId })
    },
    async heartbeat() {
      await sdk.heartbeat()
      return { ok: true }
    },
    async close() {
      if (closed) return
      closed = true
      if (activeImage) {
        await cancelImage(activeImage)
        await activeImage.settled?.catch(() => {})
      }
      if (diffusionModelId) {
        await sdk.unloadModel({
          modelId: diffusionModelId,
          clearStorage: false,
          autoClose: false
        })
      }
      await sdk.close()
    }
  }
}

function boundedStats(
  stats: Readonly<Record<string, number | string | undefined>> | undefined
) {
  const allowed = new Set([
    'modelLoadMs',
    'generationMs',
    'totalGenerationMs',
    'totalWallMs',
    'totalSteps',
    'totalGenerations',
    'totalImages',
    'totalPixels',
    'width',
    'height',
    'seed'
  ])
  const bounded: Record<string, number> = {}
  for (const [key, value] of Object.entries(stats ?? {})) {
    if (allowed.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      bounded[key] = value
    }
  }
  return bounded
}

async function* sdkEvents(
  events: AsyncIterable<SdkCompletionEvent>
): AsyncGenerator<SdkRuntimeEvent> {
  for await (const event of events) {
    switch (event.type) {
      case 'contentDelta':
      case 'thinkingDelta':
        yield { type: event.type, text: event.text ?? '' }
        break
      case 'toolCall':
        if (!event.call) {
          yield { type: 'error', message: 'SDK tool call omitted call details' }
          break
        }
        yield {
          type: 'toolCall',
          id: event.call.id,
          name: event.call.name,
          arguments: event.call.arguments,
          ...(event.call.raw ? { raw: event.call.raw } : {})
        }
        break
      case 'completionStats': {
        const metrics: Record<string, number> = {}
        for (const [key, value] of Object.entries(event.stats ?? {})) {
          if (typeof value === 'number') metrics[key] = value
        }
        yield { type: 'metrics', metrics }
        break
      }
      case 'toolError':
        yield { type: 'error', message: event.error?.message ?? 'SDK tool error' }
        break
      case 'completionDone':
        if (event.stopReason === 'cancelled') yield { type: 'cancelled' }
        else if (event.stopReason === 'error') {
          yield { type: 'error', message: event.error?.message ?? 'SDK completion error' }
        } else {
          yield {
            type: 'completion-done',
            ...(event.raw ? { raw: event.raw } : {})
          }
        }
        break
      case 'rawDelta':
        break
    }
  }
}

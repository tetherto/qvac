import { send, stream } from '@/client/rpc/rpc-client'
import { startLoggingStreamForModel } from '@/client/logging-stream-registry'
import {
  type LoadModelOptions,
  type LoadCustomPluginModelOptions,
  type LoadModelDescriptorOnlyOptions,
  type LoadModelDescriptorParam,
  type ReloadConfigOptions,
  type RPCOptions,
  type ModelDescriptor,
  type SdcppConfig,
  loadBuiltinToRequestSchema,
  loadCustomPluginToRequestSchema,
  reloadConfigOptionsToRequestSchema,
  isBuiltInModelType,
  isModelTypeAlias,
  normalizeModelType,
  inferModelTypeFromModelSrc,
  ModelType
} from '@qvac/inference/surface'
import {
  ModelLoadFailedError,
  ModelTypeRequiredError,
  StreamEndedError,
  InvalidResponseError
} from '@/utils/errors-client'
import { assertModelSrcMatchesModelType } from '@/utils/load-model-validation'
import { parseClientInput } from '@/client/parse-input'
import { getClientLogger } from '@/logging'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

const logger = getClientLogger()

interface ReactNativeRuntimeGlobal {
  navigator?: { product?: string }
}

function isReactNativeRuntime() {
  const runtime = globalThis as ReactNativeRuntimeGlobal
  return runtime.navigator?.product === 'ReactNative'
}

let warnedLocalVideoModelLoad = false

/**
 * Loads a model from a descriptor; `modelType` is inferred from `modelSrc`.
 * `modelConfig` narrows per-engine when `modelSrc.engine` is a literal,
 * otherwise falls back to a permissive shape.
 *
 * @overloadLabel "From descriptor"
 *
 * @throws {ModelTypeRequiredError} When `modelType` cannot be inferred from `modelSrc` at runtime.
 */
export function loadModel<S extends ModelDescriptor>(
  options: LoadModelDescriptorParam<S>,
  rpcOptions?: RPCOptions
): Promise<string> & { requestId: string }

/**
 * Loads a machine learning model from a local path, remote URL, or Hyperdrive key.
 *
 * @overloadLabel "Load new model"
 *
 * @throws {QvacErrorBase} When model loading fails, with details in the error message
 *
 * @throws {QvacErrorBase} When streaming ends unexpectedly (only when using onProgress)
 *
 * @throws {QvacErrorBase} When receiving an invalid response type from the server
 */
export function loadModel(
  options: LoadModelOptions,
  rpcOptions?: RPCOptions
): Promise<string> & { requestId: string }

/**
 * Loads a custom plugin model (any non-built-in `modelType` string).
 * `modelConfig` is plugin-defined; the SDK does not narrow it.
 *
 * @overloadLabel "Custom plugin"
 */
export function loadModel<T extends string>(
  options: LoadCustomPluginModelOptions<T>,
  rpcOptions?: RPCOptions
): Promise<string> & { requestId: string }

/**
 * Hot-reloads configuration on an already loaded model.
 *
 * @overloadLabel "Hot-reload config"
 *
 * @throws {QvacErrorBase} When model reload fails, with details in the error message
 *
 * @throws {QvacErrorBase} When receiving an invalid response type from the server
 */
export function loadModel(
  options: ReloadConfigOptions,
  rpcOptions?: RPCOptions
): Promise<string> & { requestId: string }

export function loadModel(
  options:
    | LoadModelOptions
    | LoadCustomPluginModelOptions<string>
    | LoadModelDescriptorOnlyOptions
    | ReloadConfigOptions,
  rpcOptions?: RPCOptions
): Promise<string> & { requestId: string } {
  // Generate a stable `requestId` once, synchronously, before kicking
  // off any async work. The same id is:
  //   - threaded onto the request envelope (`request.requestId`) so the
  //     server's `registry.begin(...)` records it on the registry
  //     entry; and
  //   - attached to the returned promise via `decoratePromise` so the
  //     caller can target this exact call with `cancel({ requestId })`
  //     before `await` resolves. Generating client-side and surfacing
  //     it synchronously is what closes the "stop-button race" gap for
  //     `loadModel` / `downloadAsset` callers — same shape as the
  //     `CompletionRun.requestId` contract.
  const requestId = generateClientRequestId()
  const inner = runLoadModel(options, requestId, rpcOptions)
  return decoratePromise(inner, { requestId })
}

async function runLoadModel(
  options:
    | LoadModelOptions
    | LoadCustomPluginModelOptions<string>
    | LoadModelDescriptorOnlyOptions
    | ReloadConfigOptions,
  requestId: string,
  rpcOptions?: RPCOptions
): Promise<string> {
  const isReloadConfig = 'modelId' in options && !('modelSrc' in options)

  // Infer `modelType` from `modelSrc` when omitted; the schema still validates
  // the resolved options below.
  let resolvedOptions = options as Record<string, unknown>
  if (!isReloadConfig) {
    let modelType = resolvedOptions['modelType']
    if (typeof modelType === 'string') {
      assertModelSrcMatchesModelType(resolvedOptions['modelSrc'], modelType)
    } else if (modelType === undefined) {
      const inferred = inferModelTypeFromModelSrc(resolvedOptions['modelSrc'])
      if (!inferred) {
        throw new ModelTypeRequiredError()
      }
      resolvedOptions = { ...resolvedOptions, modelType: inferred }
      modelType = inferred
    }

    if (typeof modelType === 'string' && isModelTypeAlias(modelType)) {
      const canonical = normalizeModelType(modelType)
      logger.warn(
        `Model type "${modelType}" is an alias and will be deprecated. Use "${canonical}" instead.`
      )
    }

    const canonicalModelType =
      typeof modelType === 'string' ? normalizeModelType(modelType) : modelType
    const modelConfig = resolvedOptions['modelConfig'] as SdcppConfig | undefined
    if (
      isReactNativeRuntime() &&
      canonicalModelType === ModelType.sdcppGeneration &&
      modelConfig?.mode === 'video' &&
      !warnedLocalVideoModelLoad
    ) {
      warnedLocalVideoModelLoad = true
      const message =
        'QVAC video generation works on React Native, but loading the video ' +
        'model on-device will usually fail or take several minutes — the video ' +
        'diffusion models currently shipped by the SDK are too large to load ' +
        'on typical mobile devices.'
      logger.warn(message)
    }
  }

  // Splice the client-generated `requestId` onto the resolved options so
  // the wire envelope carries it. The server uses the same value as the
  // registry-entry key — that match is what makes
  // `cancel({ requestId: op.requestId })` a no-op when no match exists
  // and a precise abort when it does.
  resolvedOptions = { ...resolvedOptions, requestId }

  const request = isReloadConfig
    ? parseClientInput(reloadConfigOptionsToRequestSchema, resolvedOptions)
    : isBuiltInModelType(resolvedOptions['modelType'])
      ? parseClientInput(loadBuiltinToRequestSchema, resolvedOptions)
      : parseClientInput(loadCustomPluginToRequestSchema, resolvedOptions)
  const modelLogger = isReloadConfig
    ? undefined
    : (resolvedOptions['logger'] as LoadModelOptions['logger'])
  const onProgress = isReloadConfig
    ? undefined
    : (resolvedOptions['onProgress'] as LoadModelOptions['onProgress'])

  if (onProgress) {
    // Use streaming for progress updates
    for await (const response of stream(request, rpcOptions)) {
      if (response.type === 'modelProgress') {
        onProgress(response)
      } else if (response.type === 'loadModel') {
        if (!response.success) {
          throw new ModelLoadFailedError(response.error)
        }

        const modelId = response.modelId!

        // Start logging stream in the background if logger is provided, catch to avoid failing the entire loadModel operation
        if (modelLogger) {
          try {
            startLoggingStreamForModel(modelId, modelLogger)
          } catch (error) {
            logger.warn(`Failed to start logging stream for model ${modelId}:`, error)
          }
        }

        return modelId
      }
    }
    throw new StreamEndedError()
  }

  // Use regular send for simple loading
  const response = await send(request, rpcOptions)
  if (response.type !== 'loadModel') {
    throw new InvalidResponseError('loadModel')
  }

  if (!response.success) {
    throw new ModelLoadFailedError(response.error)
  }

  const modelId = response.modelId!

  if (modelLogger) {
    try {
      startLoggingStreamForModel(modelId, modelLogger)
    } catch (error) {
      logger.warn(`Failed to start logging stream for model ${modelId}:`, error)
    }
  }

  return modelId
}

import { send, stream } from "@/client/rpc/rpc-client";
import { startLoggingStreamForModel } from "@/client/logging-stream-registry";
import {
  type LoadModelOptions,
  type LoadCustomPluginModelOptions,
  type LoadModelDescriptorOnlyOptions,
  type LoadModelDescriptorParam,
  type ReloadConfigOptions,
  type RPCOptions,
  type ModelDescriptor,
  loadModelOptionsToRequestSchema,
  reloadConfigOptionsToRequestSchema,
  isModelTypeAlias,
  normalizeModelType,
  inferModelTypeFromModelSrc,
} from "@/schemas";
import {
  ModelLoadFailedError,
  ModelTypeRequiredError,
  StreamEndedError,
  InvalidResponseError,
} from "@/utils/errors-client";
import { assertModelSrcMatchesModelType } from "@/utils/load-model-validation";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

/**
 * Loads a model from a descriptor; `modelType` is inferred from `modelSrc`.
 * `modelConfig` narrows per-engine when `modelSrc.engine` is a literal,
 * otherwise falls back to a permissive shape. Throws `ModelTypeRequiredError`
 * if `modelType` cannot be inferred at runtime.
 *
 * @example
 * ```typescript
 * await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelConfig: { ctx_size: 2048 } });
 * await loadModel({ modelSrc: WHISPER_TINY });
 * ```
 */
export function loadModel<S extends ModelDescriptor>(
  options: LoadModelDescriptorParam<S>,
  rpcOptions?: RPCOptions,
): Promise<string>;

/**
 * Loads a machine learning model from a local path, remote URL, or Hyperdrive key.
 *
 * This function supports multiple model types: LLM (Large Language Model), Whisper (speech recognition),
 * embeddings, NMT (translation), and TTS. It can handle both local file paths and Hyperdrive URLs (pear://).
 *
 * When `onProgress` is provided, the function uses streaming to provide real-time download progress.
 * Otherwise, it uses a simple request-response pattern for faster execution.
 *
 * @param options - An object that defines all configuration parameters required for loading the model, including:
 *   - modelSrc: The location from which the model weights are fetched (local path, remote URL, or Hyperdrive URL)
 *   - modelType: The type of model ("llm", "whisper", "embeddings", "nmt", or "tts")
 *   - modelConfig: Model-specific configuration options (companion sources, model parameters, etc.)
 *   - onProgress: Callback for download progress updates
 *   - logger: Logger instance for model operation logs
 * @param rpcOptions - Optional RPC options including per-call profiling configuration
 *
 * @returns Promise that resolves to the model ID (either the provided modelSrc or a generated ID)
 *
 * @throws {QvacErrorBase} When model loading fails, with details in the error message
 * @throws {QvacErrorBase} When streaming ends unexpectedly (only when using onProgress)
 * @throws {QvacErrorBase} When receiving an invalid response type from the server
 *
 * @example
 * ```typescript
 * // Local file path - absolute path
 * const localModelId = await loadModel({
 *   modelSrc: "/home/user/models/llama-7b.gguf",
 *   modelType: "llm",
 *   modelConfig: { ctx_size: 2048 }
 * });
 *
 * // Local file path - relative path
 * const relativeModelId = await loadModel({
 *   modelSrc: "./models/whisper-base.gguf",
 *   modelType: "whisper"
 * });
 *
 * // Hyperdrive URL with key and path
 * const hyperdriveId = await loadModel({
 *   modelSrc: "pear://<hyperdrive-key>/llama-7b.gguf",
 *   modelType: "llm",
 *   modelConfig: { ctx_size: 2048 }
 * });
 *
 * // Remote HTTP/HTTPS URL with progress tracking
 * const remoteId = await loadModel({
 *   modelSrc: "https://huggingface.co/TheBloke/Llama-2-7B-Chat-GGUF/resolve/main/llama-2-7b-chat.Q4_K_M.gguf",
 *   modelType: "llm",
 *   onProgress: (progress) => {
 *     console.log(`Downloaded: ${progress.percentage}%`);
 *   }
 * });
 *
 * // Multimodal model with projection
 * const multimodalId = await loadModel({
 *   modelSrc: "https://huggingface.co/.../main-model.gguf",
 *   modelType: "llm",
 *   modelConfig: {
 *     ctx_size: 512,
 *     projectionModelSrc: "https://huggingface.co/.../projection-model.gguf"
 *   },
 *   onProgress: (progress) => {
 *     console.log(`Loading: ${progress.percentage}%`);
 *   }
 * });
 *
 * // Whisper with VAD model
 * const whisperId = await loadModel({
 *   modelSrc: "https://huggingface.co/.../whisper-model.gguf",
 *   modelType: "whisper",
 *   modelConfig: {
 *     mode: "caption",
 *     output_format: "plaintext",
 *     min_seconds: 2,
 *     max_seconds: 6,
 *     vadModelSrc: "https://huggingface.co/.../vad-model.bin"
 *   }
 * });
 *
 * // Load with automatic logging - logs from the model will be forwarded to your logger
 * import { getLogger } from "@/logging";
 * const logger = getLogger("my-app");
 *
 * const modelId = await loadModel({
 *   modelSrc: "/path/to/model.gguf",
 *   modelType: "llm",
 *   logger // Pass logger in options
 * });
 * ```
 */
export function loadModel(
  options: LoadModelOptions,
  rpcOptions?: RPCOptions,
): Promise<string>;

/**
 * Loads a custom plugin model (any non-built-in `modelType` string).
 * `modelConfig` is plugin-defined; SDK does not narrow it.
 */
export function loadModel<T extends string>(
  options: LoadCustomPluginModelOptions<T>,
  rpcOptions?: RPCOptions,
): Promise<string>;

/**
 * Hot-reloads configuration on an already loaded model.
 *
 * @param options - Configuration for reloading config on an existing model:
 *   - modelId: The ID of an existing loaded model
 *   - modelType: The type of model (must match the loaded model)
 *   - modelConfig: New configuration to apply
 * @param rpcOptions - Optional RPC options including per-call profiling configuration
 *
 * @returns Promise that resolves to the model ID
 *
 * @throws {QvacErrorBase} When model reload fails, with details in the error message
 * @throws {QvacErrorBase} When receiving an invalid response type from the server
 *
 * @example
 * ```typescript
 * // Load new model
 * const modelId = await loadModel({
 *   modelSrc: "pear://<hyperdrive-key>/whisper-tiny.gguf",
 *   modelType: "whisper",
 *   modelConfig: { language: "en" },
 * });
 *
 * // Later, update the config without reloading the model
 * await loadModel({
 *   modelId,
 *   modelType: "whisper",
 *   modelConfig: { language: "es" },
 * });
 * ```
 */
export function loadModel(
  options: ReloadConfigOptions,
  rpcOptions?: RPCOptions,
): Promise<string>;

export async function loadModel(
  options:
    | LoadModelOptions
    | LoadCustomPluginModelOptions<string>
    | LoadModelDescriptorOnlyOptions
    | ReloadConfigOptions,
  rpcOptions?: RPCOptions,
): Promise<string> {
  const isReloadConfig = "modelId" in options && !("modelSrc" in options);

  // Infer `modelType` from `modelSrc` when omitted; the schema still validates
  // the resolved options below.
  let resolvedOptions = options as Record<string, unknown>;
  if (!isReloadConfig) {
    let modelType = resolvedOptions["modelType"];
    if (typeof modelType === "string") {
      assertModelSrcMatchesModelType(resolvedOptions["modelSrc"], modelType);
    } else if (modelType === undefined) {
      const inferred = inferModelTypeFromModelSrc(resolvedOptions["modelSrc"]);
      if (!inferred) {
        throw new ModelTypeRequiredError();
      }
      resolvedOptions = { ...resolvedOptions, modelType: inferred };
      modelType = inferred;
    }

    if (typeof modelType === "string" && isModelTypeAlias(modelType)) {
      const canonical = normalizeModelType(modelType);
      logger.warn(
        `Model type "${modelType}" is an alias and will be deprecated. Use "${canonical}" instead.`,
      );
    }
  }

  const request = isReloadConfig
    ? reloadConfigOptionsToRequestSchema.parse(resolvedOptions)
    : loadModelOptionsToRequestSchema.parse(resolvedOptions);
  const modelLogger = isReloadConfig
    ? undefined
    : (resolvedOptions["logger"] as LoadModelOptions["logger"]);
  const onProgress = isReloadConfig
    ? undefined
    : (resolvedOptions["onProgress"] as LoadModelOptions["onProgress"]);

  if (onProgress) {
    // Use streaming for progress updates
    for await (const response of stream(request, rpcOptions)) {
      if (response.type === "modelProgress") {
        onProgress(response);
      } else if (response.type === "loadModel") {
        if (!response.success) {
          throw new ModelLoadFailedError(response.error);
        }

        const modelId = response.modelId!;

        // Start logging stream in the background if logger is provided, catch to avoid failing the entire loadModel operation
        if (modelLogger) {
          try {
            startLoggingStreamForModel(modelId, modelLogger);
          } catch (error) {
            logger.warn(
              `Failed to start logging stream for model ${modelId}:`,
              error,
            );
          }
        }

        return modelId;
      }
    }
    throw new StreamEndedError();
  }

  // Use regular send for simple loading
  const response = await send(request, rpcOptions);
  if (response.type !== "loadModel") {
    throw new InvalidResponseError("loadModel");
  }

  if (!response.success) {
    throw new ModelLoadFailedError(response.error);
  }

  const modelId = response.modelId!;

  if (modelLogger) {
    try {
      startLoggingStreamForModel(modelId, modelLogger);
    } catch (error) {
      logger.warn(
        `Failed to start logging stream for model ${modelId}:`,
        error,
      );
    }
  }

  return modelId;
}

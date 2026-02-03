import { send, stream } from "@/client/rpc/rpc-client";
import { startLoggingStreamForModel } from "@/client/logging-stream-registry";
import {
  type LoadModelOptions,
  type ReloadConfigOptions,
  loadModelOptionsToRequestSchema,
  reloadConfigOptionsToRequestSchema,
  isModelTypeAlias,
  normalizeModelType,
} from "@/schemas";
import {
  ModelLoadFailedError,
  StreamEndedError,
  InvalidResponseError,
} from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

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
 *   - modelConfig: Model-specific configuration options
 *   - projectionModelSrc: (LLM only) Projection model source for multimodal models
 *   - vadModelSrc: (Whisper only) VAD model source for voice activity detection
 *   - onProgress: Callback for download progress updates
 *   - logger: Logger instance for model operation logs
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
 *   modelConfig: { contextSize: 2048 }
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
 *   modelConfig: { contextSize: 2048 }
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
 *   projectionModelSrc: "https://huggingface.co/.../projection-model.gguf",
 *   modelConfig: { ctx_size: 512 },
 *   onProgress: (progress) => {
 *     console.log(`Loading: ${progress.percentage}%`);
 *   }
 * });
 *
 * // Whisper with VAD model
 * const whisperId = await loadModel({
 *   modelSrc: "https://huggingface.co/.../whisper-model.gguf",
 *   modelType: "whisper",
 *   vadModelSrc: "https://huggingface.co/.../vad-model.bin",
 *   modelConfig: {
 *     mode: "caption",
 *     output_format: "plaintext",
 *     min_seconds: 2,
 *     max_seconds: 6
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
export function loadModel(options: LoadModelOptions): Promise<string>;

/**
 * Hot-reloads configuration on an already loaded model.
 *
 * @param options - Configuration for reloading config on an existing model:
 *   - modelId: The ID of an existing loaded model
 *   - modelType: The type of model (must match the loaded model)
 *   - modelConfig: New configuration to apply
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
export function loadModel(options: ReloadConfigOptions): Promise<string>;

export async function loadModel(
  options: LoadModelOptions | ReloadConfigOptions,
): Promise<string> {
  const isReloadConfig = "modelId" in options && !("modelSrc" in options);

  // Warn about deprecated alias usage
  if (!isReloadConfig && isModelTypeAlias(options.modelType)) {
    const canonical = normalizeModelType(options.modelType);
    logger.warn(
      `Model type "${options.modelType}" is an alias and will be deprecated. Use "${canonical}" instead.`,
    );
  }

  const request = isReloadConfig
    ? reloadConfigOptionsToRequestSchema.parse(options)
    : loadModelOptionsToRequestSchema.parse(options);
  const modelLogger = isReloadConfig ? undefined : options.logger;
  const onProgress = isReloadConfig ? undefined : options.onProgress;

  if (onProgress) {
    // Use streaming for progress updates
    for await (const response of stream(request)) {
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
  const response = await send(request);
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

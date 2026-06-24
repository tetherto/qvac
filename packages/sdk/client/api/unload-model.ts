import { isBare } from "which-runtime";
import { type UnloadModelRequest, type UnloadModelParams } from "@/schemas";
import { send, close } from "@/client/rpc/rpc-client";
import { stopLoggingStreamForModel } from "@/client/logging-stream-registry";
import {
  InvalidResponseError,
  ModelUnloadFailedError,
} from "@/utils/errors-client";
import { getClientLogger } from "@/logging";

const logger = getClientLogger();

/**
 * Unloads a previously loaded model from the server.
 *
 * When the last model is unloaded (no more models remain), this function
 * automatically closes the RPC connection on Node/Electron, allowing the
 * process to exit naturally without requiring manual cleanup. On Bare the
 * connection is left open by default so long-lived workers survive a routine
 * unload; pass `autoClose: true` to opt in to closing.
 *
 * @param params - The parameters for unloading the model
 * @param params.modelId - The unique identifier of the model to unload
 * @param params.clearStorage - Whether to clear the storage for the model
 * @param params.autoClose - Override the runtime-default auto-close behavior
 * @throws {QvacErrorBase} When the response type is invalid or when the unload operation fails
 */
export async function unloadModel(params: UnloadModelParams) {
  const request: UnloadModelRequest = {
    type: "unloadModel",
    modelId: params.modelId,
    clearStorage: params.clearStorage ?? false,
  };

  const response = await send(request);
  if (response.type !== "unloadModel") {
    throw new InvalidResponseError("unloadModel");
  }

  if (!response.success) {
    throw new ModelUnloadFailedError(params.modelId);
  }

  stopLoggingStreamForModel(params.modelId);

  const shouldAutoClose = params.autoClose ?? !isBare;
  if (
    shouldAutoClose &&
    response.hasActiveModels === false &&
    response.hasActiveProviders === false
  ) {
    logger.info(
      "🧹 No models or providers active, automatically closing RPC connection...",
    );
    await close();
  }
}

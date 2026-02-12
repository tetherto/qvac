import type {
  LoadModelSrcRequest,
  LoadModelResponse,
  ModelProgressUpdate,
} from "@/schemas";
import { modelInputToSrcSchema } from "@/schemas";
import { registerModel } from "@/server/bare/registry/model-registry";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { send, stream } from "@/client/rpc/rpc-client";
import { handleLoadModel } from "./load-model";
import {
  ModelLoadFailedError,
  DelegateNoFinalResponseError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export async function handleLoadModelDelegated(
  request: LoadModelSrcRequest,
  progressCallback?: (update: ModelProgressUpdate) => void,
): Promise<LoadModelResponse> {
  if (!request.delegate) {
    throw new ModelLoadFailedError(
      "Delegate information is required for delegated load model",
    );
  }

  const { delegate } = request;
  const {
    topic,
    providerPublicKey,
    timeout,
    fallbackToLocal,
    forceNewConnection,
  } = delegate;

  try {
    logger.info(
      `📤 Sending delegated loadModel request to provider: ${providerPublicKey}${timeout ? `, timeout: ${timeout}ms` : ""}${forceNewConnection ? " (forcing new connection)" : ""}`,
    );

    // Create RPC instance for this HyperSwarm peer
    const rpc = await getRPC(topic, providerPublicKey, {
      timeout,
      forceNewConnection,
    });

    // Strip out the delegate field to avoid infinite delegation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { delegate: _, ...providerRequest } = request;

    let finalResponse: LoadModelResponse | undefined;

    if (request.withProgress) {
      // Use streaming for progress updates
      logger.debug("📊 Using streaming mode for loadModel with progress");
      const responseStream = stream(
        providerRequest,
        rpc,
        timeout ? { timeout } : {},
      );

      for await (const response of responseStream) {
        if (response.type === "modelProgress") {
          // Forward progress updates to the client
          if (progressCallback) {
            progressCallback(response);
          }
        } else if (response.type === "loadModel") {
          finalResponse = response;
          break;
        }
      }

      if (!finalResponse) {
        throw new DelegateNoFinalResponseError();
      }
    } else {
      // Use simple send for non-progress requests
      logger.debug("📤 Using simple send mode for loadModel");
      finalResponse = (await send(
        providerRequest,
        rpc,
        timeout ? { timeout } : {},
      )) as LoadModelResponse;
    }

    if (!finalResponse || !finalResponse.success) {
      logger.error("Provider failed to load model:", finalResponse?.error);
      return {
        type: "loadModel",
        success: false,
        error: `Provider failed to load model: ${finalResponse?.error || "Unknown error"}`,
      };
    }

    const modelId =
      finalResponse.modelId ||
      modelInputToSrcSchema.parse(request.modelSrc) ||
      `delegated-${Date.now()}`;

    const delegateOptions: {
      topic: string;
      providerPublicKey: string;
      timeout?: number;
    } = {
      topic,
      providerPublicKey,
    };
    if (timeout !== undefined) {
      delegateOptions.timeout = timeout;
    }

    registerModel(modelId, delegateOptions);

    logger.info(
      `✅ Delegated model registered: ${modelId} -> provider: ${providerPublicKey}`,
    );

    return {
      type: "loadModel",
      success: true,
      modelId,
    };
  } catch (error) {
    logger.error("Error in delegated load model:", error);

    if (fallbackToLocal) {
      logger.info(
        "🔄 Fallback to local model loading enabled, attempting local load...",
      );
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { delegate: _, ...localRequest } = request;
        return await handleLoadModel(localRequest, progressCallback);
      } catch (localError) {
        logger.error("❌ Local fallback also failed:", localError);
        return {
          type: "loadModel",
          success: false,
          error: `Both delegated and local loading failed. Delegated error: ${error instanceof Error ? error.message : String(error)}. Local error: ${localError instanceof Error ? localError.message : String(localError)}`,
        };
      }
    }

    return {
      type: "loadModel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

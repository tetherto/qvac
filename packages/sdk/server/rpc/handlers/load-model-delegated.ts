import type {
  LoadModelSrcRequest,
  LoadModelResponse,
  ModelProgressUpdate,
} from "@/schemas";
import { DELEGATION_BREAKDOWN_KEY, OPERATION_EVENT_KEY, modelInputToSrcSchema } from "@/schemas";
import type { DelegatedHandlerOptions } from "@/server/rpc/profiling";
import type { ResponseWithDelegation } from "@/server/rpc/delegate-transport";
import { registerModel, isModelLoaded, unregisterModel } from "@/server/bare/registry/model-registry";
import {
  send,
  stream,
  type DelegateOptions,
} from "@/server/rpc/delegate-transport";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { handleLoadModel } from "./load-model";
import {
  ModelLoadFailedError,
  DelegateNoFinalResponseError,
} from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export interface HandleLoadModelDelegatedOptions extends DelegatedHandlerOptions {
  progressCallback?: (update: ModelProgressUpdate) => void;
}

export async function handleLoadModelDelegated(
  request: LoadModelSrcRequest,
  options?: HandleLoadModelDelegatedOptions,
): Promise<LoadModelResponse> {
  const { progressCallback, profilingMeta } = options ?? {};
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
    healthCheckTimeout,
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
      healthCheckTimeout,
      forceNewConnection,
    });

    // Strip out the delegate field to avoid infinite delegation
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { delegate: _, ...providerRequest } = request;

    let finalResponse: LoadModelResponse | undefined;
    let delegationBreakdown: ResponseWithDelegation[typeof DELEGATION_BREAKDOWN_KEY];
    let operationEvent: ResponseWithDelegation[typeof OPERATION_EVENT_KEY];

    // Build delegate options with profiling metadata
    const delegateOpts: DelegateOptions = { peerKey: providerPublicKey };
    if (profilingMeta) {
      delegateOpts.profilingMeta = profilingMeta;
    }
    if (timeout) {
      delegateOpts.timeout = timeout;
    }

    if (request.withProgress) {
      // Use streaming for progress updates
      logger.debug("📊 Using streaming mode for loadModel with progress");
      const responseStream = stream(providerRequest, rpc, delegateOpts);

      for await (const response of responseStream) {
        if (response.type === "modelProgress") {
          // Forward progress updates to the client
          if (progressCallback) {
            progressCallback(response);
          }
        } else if (response.type === "loadModel") {
          finalResponse = response;
          operationEvent = (response as ResponseWithDelegation)[OPERATION_EVENT_KEY];
          break;
        }
      }

      if (!finalResponse) {
        throw new DelegateNoFinalResponseError();
      }
    } else {
      // Use simple send for non-progress requests
      logger.debug("📤 Using simple send mode for loadModel");
      const providerResponse = await send(providerRequest, rpc, delegateOpts);
      finalResponse = providerResponse as LoadModelResponse;
      const typedResponse = providerResponse as ResponseWithDelegation;
      delegationBreakdown = typedResponse[DELEGATION_BREAKDOWN_KEY];
      operationEvent = typedResponse[OPERATION_EVENT_KEY];
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
      healthCheckTimeout?: number;
    } = {
      topic,
      providerPublicKey,
    };
    if (timeout !== undefined) {
      delegateOptions.timeout = timeout;
    }
    if (healthCheckTimeout !== undefined) {
      delegateOptions.healthCheckTimeout = healthCheckTimeout;
    }

    if (isModelLoaded(modelId)) {
      logger.info(
        `Delegated model ${modelId} is already registered, replacing with new provider: ${providerPublicKey}`,
      );
      unregisterModel(modelId);
    }

    registerModel(modelId, delegateOptions);
    logger.info(
      `✅ Delegated model registered: ${modelId} -> provider: ${providerPublicKey}`,
    );

    const result: LoadModelResponse = {
      type: "loadModel",
      success: true,
      modelId,
    };

    if (delegationBreakdown) {
      (result as ResponseWithDelegation)[DELEGATION_BREAKDOWN_KEY] =
        delegationBreakdown;
    }
    if (operationEvent) {
      (result as ResponseWithDelegation)[OPERATION_EVENT_KEY] = operationEvent;
    }

    return result;
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

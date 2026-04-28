import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { getServerLogger } from "@/logging";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { send, type DelegateOptions } from "@/server/rpc/delegate-transport";
import type { DelegatedHandlerOptions } from "@/server/rpc/profiling";

const logger = getServerLogger();

type DelegationTarget = {
  topic: string;
  providerPublicKey: string;
  timeout?: number;
};

function resolveDelegationTarget(
  request: CancelRequest,
): DelegationTarget | null {
  if (request.operation === "inference" || request.operation === "embeddings") {
    const entry = getModelEntry(request.modelId);
    if (!entry?.isDelegated) {
      return null;
    }
    const target: DelegationTarget = {
      topic: entry.delegated.topic,
      providerPublicKey: entry.delegated.providerPublicKey,
    };
    if (entry.delegated.timeout !== undefined) {
      target.timeout = entry.delegated.timeout;
    }
    return target;
  }

  if (request.operation === "downloadAsset" && request.delegate) {
    const target: DelegationTarget = {
      topic: request.delegate.topic,
      providerPublicKey: request.delegate.providerPublicKey,
    };
    if (request.delegate.timeout !== undefined) {
      target.timeout = request.delegate.timeout;
    }
    return target;
  }

  return null;
}

function toProviderCancelRequest(request: CancelRequest): CancelRequest {
  if (request.operation !== "downloadAsset") {
    return request;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { delegate: _delegate, ...providerRequest } = request;
  return providerRequest as CancelRequest;
}

export async function handleCancelDelegated(
  request: CancelRequest,
  options?: DelegatedHandlerOptions,
): Promise<CancelResponse> {
  const target = resolveDelegationTarget(request);
  if (!target) {
    logger.warn(
      `Delegated cancel skipped (no delegation target): operation=${request.operation}`,
    );
    return { type: "cancel", success: true };
  }

  try {
    const rpc = await getRPC(target.topic, target.providerPublicKey, {
      timeout: target.timeout,
    });

    const delegateOpts: DelegateOptions = {
      peerKey: target.providerPublicKey,
    };
    if (target.timeout !== undefined) {
      delegateOpts.timeout = target.timeout;
    }
    if (options?.profilingMeta) {
      delegateOpts.profilingMeta = options.profilingMeta;
    }

    await send(toProviderCancelRequest(request), rpc, delegateOpts);
    return { type: "cancel", success: true };
  } catch (error) {
    logger.error("Error during delegated cancellation:", error);
    return {
      type: "cancel",
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

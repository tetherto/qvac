import type { CancelRequest, CancelResponse } from "@/schemas/cancel";
import { getServerLogger } from "@/logging";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { send, type DelegateOptions } from "@/server/rpc/delegate-transport";
import type { DelegatedHandlerOptions } from "@/server/rpc/profiling";

const logger = getServerLogger();

type DelegationTarget = {
  providerPublicKey: string;
  timeout?: number;
};

/**
 * Resolve the delegated provider for a cancel request, if any.
 *
 * After the 0.11.0 wire-schema collapse the cancel envelope has only
 * two operations. Only `broad` cancels delegate at the cancel layer —
 * see `isCancelDelegated` in `handler-registry.ts` for the policy and
 * the rationale.
 *
 * The targeted `request` arm is handled locally because the registry
 * is worker-singleton and already holds the entry for delegated
 * requests (the delegated handler registers its own context on the
 * provider-facing side). For pre-0.11.0 behaviour where a `requestId`
 * cancel against a delegated model needed to round-trip to the
 * provider, hold onto the delegated `loadModel(...).requestId` and
 * fire a broad cancel against the model id instead.
 */
function resolveDelegationTarget(
  request: CancelRequest,
): DelegationTarget | null {
  if (request.operation !== "broad") return null;

  const entry = getModelEntry(request.modelId);
  if (!entry?.isDelegated) return null;

  const target: DelegationTarget = {
    providerPublicKey: entry.delegated.providerPublicKey,
  };
  if (entry.delegated.timeout !== undefined) {
    target.timeout = entry.delegated.timeout;
  }
  return target;
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
    const rpc = await getRPC(target.providerPublicKey, {
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

    await send(request, rpc, delegateOpts);
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

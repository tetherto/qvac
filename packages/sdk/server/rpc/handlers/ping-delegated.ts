import type { PingRequest, PingResponse } from "@/schemas";
import { getServerLogger } from "@/logging";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { send, type DelegateOptions } from "@/server/rpc/delegate-transport";
import { DelegateConnectionFailedError } from "@/utils/errors-server";
import type { DelegatedHandlerOptions } from "@/server/rpc/profiling";

const logger = getServerLogger();

export async function handlePingDelegated(
  request: PingRequest,
  options?: DelegatedHandlerOptions,
): Promise<PingResponse> {
  const { delegate } = request;
  if (!delegate) {
    throw new DelegateConnectionFailedError(
      "Delegated ping handler called without delegate info",
    );
  }

  const { topic, providerPublicKey, timeout } = delegate;

  try {
    const rpc = await getRPC(topic, providerPublicKey, { timeout });

    const delegateOpts: DelegateOptions = {
      peerKey: providerPublicKey,
    };
    if (timeout !== undefined) {
      delegateOpts.timeout = timeout;
    }
    if (options?.profilingMeta) {
      delegateOpts.profilingMeta = options.profilingMeta;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { delegate: _delegate, ...providerRequest } = request;
    const response = await send(providerRequest as PingRequest, rpc, delegateOpts);
    return response as PingResponse;
  } catch (error) {
    logger.error("Error during delegated ping:", error);
    throw error;
  }
}

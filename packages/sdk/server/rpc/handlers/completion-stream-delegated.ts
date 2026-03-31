import type {
  CompletionStreamRequest,
  CompletionStreamResponse,
} from "@/schemas";
import type { DelegatedHandlerOptions } from "@/server/rpc/profiling";
import { getModelEntry } from "@/server/bare/registry/model-registry";
import { getRPC } from "@/server/bare/delegate-rpc-client";
import { stream, type DelegateOptions } from "@/server/rpc/delegate-transport";
import { ModelIsDelegatedError } from "@/utils/errors-server";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

export type HandleCompletionStreamDelegatedOptions = DelegatedHandlerOptions;

export async function* handleCompletionStreamDelegated(
  request: CompletionStreamRequest,
  options?: HandleCompletionStreamDelegatedOptions,
): AsyncGenerator<CompletionStreamResponse> {
  const { profilingMeta } = options ?? {};

  // Get delegation info from model registry
  const entry = getModelEntry(request.modelId);

  if (!entry?.isDelegated || !entry.delegated) {
    throw new ModelIsDelegatedError(request.modelId);
  }

  const { topic, providerPublicKey, timeout, healthCheckTimeout } = entry.delegated;

  try {
    logger.debug(
      `📤 Sending delegated completionStream request to provider: ${providerPublicKey}${timeout ? `, timeout: ${timeout}ms` : ""}`,
    );

    // Create RPC instance for this HyperSwarm peer
    const rpc = await getRPC(topic, providerPublicKey, { timeout, healthCheckTimeout });

    // Build delegate options with profiling metadata
    const delegateOpts: DelegateOptions = { peerKey: providerPublicKey };
    if (profilingMeta) {
      delegateOpts.profilingMeta = profilingMeta;
    }
    if (timeout) {
      delegateOpts.timeout = timeout;
    }

    // Use the regular stream function with the HyperSwarm RPC instance
    const responseStream = stream(request, rpc, delegateOpts);

    // Yield each response from the stream
    for await (const response of responseStream) {
      yield response as CompletionStreamResponse;
    }
  } catch (error) {
    logger.error("Error in delegated completion stream:", error);
    yield {
      type: "completionStream",
      token: `Error communicating with provider: ${error instanceof Error ? error.message : String(error)}`,
      done: true,
    };
  }
}

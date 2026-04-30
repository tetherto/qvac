import { send, stream } from "@/client/rpc/rpc-client";
import type {
  PluginInvokeRequest,
  PluginInvokeStreamRequest,
  PluginInvokeStreamResponse,
  RPCOptions,
} from "@/schemas";
import { InvalidResponseError } from "@/utils/errors-client";

export interface InvokePluginOptions<TParams = unknown> {
  modelId: string;
  handler: string;
  params: TParams;
}

/**
 * Invoke a non-streaming plugin handler.
 *
 * @param options - Invocation payload.
 * @param options.modelId - The identifier of the model instance that owns the plugin.
 * @param options.handler - Name of the plugin handler to invoke.
 * @param options.params - Handler-specific parameters, passed through to the plugin.
 * @param rpcOptions - Optional RPC options (timeout, profiling, force new connection, etc.).
 * @returns A promise resolving to the handler's result payload (typed via the `TResponse` generic).
 * @throws {QvacErrorBase} When the response type is invalid (`InvalidResponseError`) or the RPC layer fails.
 */
export async function invokePlugin<TResponse = unknown, TParams = unknown>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions,
): Promise<TResponse> {
  const request: PluginInvokeRequest = {
    type: "pluginInvoke",
    modelId: options.modelId,
    handler: options.handler,
    params: options.params,
  };

  const response = await send(request, rpcOptions);

  if (response.type !== "pluginInvoke") {
    throw new InvalidResponseError("pluginInvoke");
  }

  return response.result as TResponse;
}

/**
 * Invoke a streaming plugin handler.
 *
 * @param options - Invocation payload.
 * @param options.modelId - The identifier of the model instance that owns the plugin.
 * @param options.handler - Name of the plugin stream handler to invoke.
 * @param options.params - Handler-specific parameters, passed through to the plugin.
 * @param rpcOptions - Optional RPC options (timeout, profiling, force new connection, etc.).
 * @returns An async generator yielding chunk payloads (typed via the `TResponse` generic) until the stream completes.
 * @throws {QvacErrorBase} When an intermediate response has the wrong type (`InvalidResponseError`) or the RPC layer fails.
 */
export async function* invokePluginStream<
  TResponse = unknown,
  TParams = unknown,
>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions,
): AsyncGenerator<TResponse> {
  const request: PluginInvokeStreamRequest = {
    type: "pluginInvokeStream",
    modelId: options.modelId,
    handler: options.handler,
    params: options.params,
  };

  for await (const chunk of stream(request, rpcOptions)) {
    const response = chunk as PluginInvokeStreamResponse;
    if (response.type !== "pluginInvokeStream") {
      throw new InvalidResponseError("pluginInvokeStream");
    }
    if (!response.done) {
      yield response.result as TResponse;
    }
  }
}

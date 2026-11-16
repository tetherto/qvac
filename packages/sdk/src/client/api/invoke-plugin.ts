import { send, stream } from '@/client/rpc/rpc-client'
import type {
  PluginInvokeRequest,
  PluginInvokeStreamRequest,
  PluginInvokeStreamResponse,
  RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'
import { decoratePromise } from '@/utils/decorate-promise'
import { generateClientRequestId } from '@/client/api/client-request-id'

export interface InvokePluginOptions<TParams = unknown> {
  modelId: string
  handler: string
  params: TParams
  /** Caller-minted id for `cancel({ requestId })`; generated when omitted. */
  requestId?: string
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
export function invokePlugin<TResponse = unknown, TParams = unknown>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions
): Promise<TResponse> & { requestId: string } {
  const requestId = options.requestId ?? generateClientRequestId()
  return decoratePromise(runInvokePlugin<TResponse, TParams>(options, requestId, rpcOptions), {
    requestId
  })
}

async function runInvokePlugin<TResponse, TParams>(
  options: InvokePluginOptions<TParams>,
  requestId: string,
  rpcOptions?: RPCOptions
): Promise<TResponse> {
  const request: PluginInvokeRequest = {
    type: 'pluginInvoke',
    requestId,
    modelId: options.modelId,
    handler: options.handler,
    params: options.params
  }

  const response = await send(request, rpcOptions)

  if (response.type !== 'pluginInvoke') {
    throw new InvalidResponseError('pluginInvoke')
  }

  return response.result as TResponse
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
export function invokePluginStream<TResponse = unknown, TParams = unknown>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions
): AsyncGenerator<TResponse> & { requestId: string } {
  const requestId = options.requestId ?? generateClientRequestId()
  const generator = runInvokePluginStream<TResponse, TParams>(options, requestId, rpcOptions)
  return Object.assign(generator, { requestId })
}

async function* runInvokePluginStream<TResponse, TParams>(
  options: InvokePluginOptions<TParams>,
  requestId: string,
  rpcOptions?: RPCOptions
): AsyncGenerator<TResponse> {
  const request: PluginInvokeStreamRequest = {
    type: 'pluginInvokeStream',
    requestId,
    modelId: options.modelId,
    handler: options.handler,
    params: options.params
  }

  for await (const chunk of stream(request, rpcOptions)) {
    const response = chunk as PluginInvokeStreamResponse
    if (response.type !== 'pluginInvokeStream') {
      throw new InvalidResponseError('pluginInvokeStream')
    }
    if (!response.done) {
      yield response.result as TResponse
    }
  }
}

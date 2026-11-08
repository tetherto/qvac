import { send, stream } from '@/client/rpc/rpc-client'
import type {
  PluginInvokeRequest,
  PluginInvokeStreamRequest,
  PluginInvokeStreamResponse,
  RPCOptions
} from '@qvac/inference/surface'
import { InvalidResponseError } from '@/utils/errors-client'

export interface InvokePluginOptions<TParams = unknown> {
  modelId: string
  handler: string
  params: TParams
}

/**
 * Invoke a non-streaming plugin handler.
 *
 * @throws {QvacErrorBase} When the response type is invalid (`InvalidResponseError`) or the RPC layer fails.
 */
export async function invokePlugin<TResponse = unknown, TParams = unknown>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions
): Promise<TResponse> {
  const request: PluginInvokeRequest = {
    type: 'pluginInvoke',
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
 * @throws {QvacErrorBase} When an intermediate response has the wrong type (`InvalidResponseError`) or the RPC layer fails.
 */
export async function* invokePluginStream<TResponse = unknown, TParams = unknown>(
  options: InvokePluginOptions<TParams>,
  rpcOptions?: RPCOptions
): AsyncGenerator<TResponse> {
  const request: PluginInvokeStreamRequest = {
    type: 'pluginInvokeStream',
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

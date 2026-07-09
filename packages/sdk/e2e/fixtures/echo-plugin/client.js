import { invokePlugin, invokePluginStream } from '@qvac/sdk'

export async function echo(modelId, message) {
  return invokePlugin({
    modelId,
    handler: 'echo',
    params: { message }
  })
}

export async function* echoStream(modelId, message) {
  const stream = invokePluginStream({
    modelId,
    handler: 'echoStream',
    params: { message }
  })
  for await (const chunk of stream) {
    yield chunk
  }
}

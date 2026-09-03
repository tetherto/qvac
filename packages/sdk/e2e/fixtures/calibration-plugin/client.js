import { invokePluginStream } from '@qvac/sdk'

export async function* calibrate(modelId) {
  const stream = invokePluginStream({
    modelId,
    handler: 'calibrate',
    params: {}
  })
  for await (const chunk of stream) {
    yield chunk
  }
}

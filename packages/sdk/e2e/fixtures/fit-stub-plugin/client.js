import { invokePlugin } from '@qvac/sdk'

// Plugin handlers only see the params object, so the model id rides inside it.
export async function fitStubCheck(modelId, params = {}) {
  return invokePlugin({
    modelId,
    handler: 'check',
    params: { modelId, ...params }
  })
}

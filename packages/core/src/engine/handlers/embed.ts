import type { EmbedRequest, EmbedResponse } from '../../schemas'
import { dispatchPluginReply } from '../../handlers/plugin-dispatch'

export async function handleEmbed(request: EmbedRequest): Promise<EmbedResponse> {
  return dispatchPluginReply<EmbedRequest, EmbedResponse>(request.modelId, 'embed', request)
}

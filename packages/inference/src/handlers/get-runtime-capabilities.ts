import type { GetRuntimeCapabilitiesResponse } from '@/schemas/capabilities'
import { getProvidedCapabilities } from '@/plugins/registry'

export function handleGetRuntimeCapabilities(): GetRuntimeCapabilitiesResponse {
  return { type: 'getRuntimeCapabilities', capabilities: getProvidedCapabilities() }
}

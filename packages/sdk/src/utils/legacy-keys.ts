import { createLegacyKeyWarner } from '@qvac/inference/surface'
import { getClientLogger } from '@/logging'

export const warnLegacyKey = createLegacyKeyWarner((message) => {
  getClientLogger().warn(message)
})

import { createLegacyKeyWarner } from '@/schemas/legacy-keys'
import { getAppLogger } from '@/logging/index'

export const warnLegacyKey = createLegacyKeyWarner((message) => {
  getAppLogger().warn(message)
})

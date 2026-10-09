import type { DecideConfig } from '@/schemas/index'

export function transformDecideConfig(config: DecideConfig): DecideConfig {
  return { ...config }
}

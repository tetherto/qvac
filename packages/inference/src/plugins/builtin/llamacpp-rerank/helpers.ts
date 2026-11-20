import type { RerankConfig as NativeRerankConfig } from '@qvac/embed-llamacpp'
import type { RerankConfig } from '@/schemas/index'
import { toNativeEmbedLlamacppConfig } from '@/plugins/ops/embed-llamacpp-config'

export function transformRerankConfig(config: RerankConfig): NativeRerankConfig {
  return { ...toNativeEmbedLlamacppConfig(config), device: config.device }
}

import type { RerankConfig as NativeRerankConfig } from '@qvac/embed-llamacpp'
import type { RerankConfig } from '@/schemas/index'

export function transformRerankConfig(config: RerankConfig): NativeRerankConfig {
  const { pollBatch, backend, ...nativeConfig } = config
  const transformed: NativeRerankConfig = {
    ...Object.fromEntries(
      Object.entries(nativeConfig)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    ),
    device: config.device
  }

  if (pollBatch !== undefined) {
    transformed['poll-batch'] = `${pollBatch}`
  }

  if (backend !== undefined) {
    transformed.backend = backend.join(',')
  }

  return transformed
}

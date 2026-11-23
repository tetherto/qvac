const KV_CACHE_POLICY_DEFAULTS: Readonly<Record<string, unknown>> = {
  cache_share_across_keys: false
}

const kvCacheDirIds = new Map<string, string>()

export function kvCacheIdentityConfig(
  config: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!config) return config
  const identity: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    identity[key] = Object.hasOwn(KV_CACHE_POLICY_DEFAULTS, key)
      ? KV_CACHE_POLICY_DEFAULTS[key]
      : value
  }
  return identity
}

export function setKvCacheDirId(modelId: string, cacheDirId: string): void {
  kvCacheDirIds.set(modelId, cacheDirId)
}

export function kvCacheDirIdFor(modelId: string): string {
  return kvCacheDirIds.get(modelId) ?? modelId
}

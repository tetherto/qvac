export function withNativeKeys(
  config: object,
  nativeKeys: Readonly<Record<string, string>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [nativeKeys[key] ?? key, value])
  )
}

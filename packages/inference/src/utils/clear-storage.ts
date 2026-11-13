export function resolveClearStorageTarget(
  modelPath: string,
  modelsCacheDir: string
): { path: string; kind: 'file' | 'directory' } {
  const normalizedCache = modelsCacheDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = modelPath.replace(/\\/g, '/')

  if (!normalizedPath.startsWith(`${normalizedCache}/`)) {
    return { path: modelPath, kind: 'file' }
  }

  const relativePath = normalizedPath.slice(normalizedCache.length + 1)
  const parts = relativePath.split('/')

  if (parts.length === 3 && (parts[0] === 'sets' || parts[0] === 'onnx') && parts[1] && parts[2]) {
    const lastSlash = normalizedPath.lastIndexOf('/')
    return { path: normalizedPath.slice(0, lastSlash), kind: 'directory' }
  }

  return { path: modelPath, kind: 'file' }
}

/**
 * Whether a sharded model sits directly in a cache shard directory,
 * `<cache>/sharded/<key>/`. That directory holds one model, so it is the only
 * one `clearStorage` may remove whole. Backslashes count as separators only
 * when `sep` is one (Windows), and dot segments never match.
 */
export function isCacheShardPath(
  modelPath: string,
  modelsCacheDir: string,
  sep: string = '/'
): boolean {
  const toSlashes = (p: string) => (sep === '\\' ? p.replace(/\\/g, '/') : p)
  const normalizedCache = toSlashes(modelsCacheDir).replace(/\/+$/, '')
  const normalizedPath = toSlashes(modelPath)

  if (!normalizedPath.startsWith(`${normalizedCache}/`)) {
    return false
  }

  const parts = normalizedPath.slice(normalizedCache.length + 1).split('/')
  return (
    parts.length === 3 &&
    parts[0] === 'sharded' &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

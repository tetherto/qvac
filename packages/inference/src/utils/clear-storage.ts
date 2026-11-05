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
 * Returns the deletion targets for `clearStorage` on a sharded model. A shard
 * directory in the QVAC cache (`sharded/<key>/`) holds only that model and is
 * removed whole. Anywhere else, only the model's own files are removed, never
 * the directory they sit in.
 */
export function resolveShardedClearStorageTargets(
  modelPath: string,
  modelsCacheDir: string,
  modelFiles: readonly string[]
): { path: string; kind: 'file' | 'directory' }[] {
  const normalizedCache = modelsCacheDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = modelPath.replace(/\\/g, '/')
  const lastSlash = normalizedPath.lastIndexOf('/')
  const shardDir = lastSlash === -1 ? '.' : normalizedPath.slice(0, lastSlash)

  if (normalizedPath.startsWith(`${normalizedCache}/`)) {
    const parts = normalizedPath.slice(normalizedCache.length + 1).split('/')
    if (parts.length === 3 && parts[0] === 'sharded' && parts[1] && parts[2]) {
      return [{ path: shardDir, kind: 'directory' }]
    }
  }

  return modelFiles.map((name) => ({ path: `${shardDir}/${name}`, kind: 'file' as const }))
}

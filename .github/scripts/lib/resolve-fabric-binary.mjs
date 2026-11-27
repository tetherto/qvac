import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { accessSync } from 'node:fs'

export function resolveFabricCore(base, host) {
  if (!/^linux-(x64|arm64)$/.test(host ?? '')) {
    throw new Error('--fabric-host requires linux-x64 or linux-arm64')
  }
  const consumer = createRequire(join(resolve(base), 'package.json'))
  const fabricManifest = consumer.resolve('@qvac/fabric/package')
  const provider = createRequire(fabricManifest)
  const platform = `@qvac/fabric-${host}/package`
  const manifest = resolvePlatformManifest(provider, consumer, platform)
  const binary = join(
    dirname(manifest),
    'prebuilds',
    host,
    `qvac__fabric-${host}`,
    'libqvac-ggml-base-1.so'
  )
  accessSync(binary)
  return binary
}

function resolvePlatformManifest(provider, consumer, platform) {
  try {
    return provider.resolve(platform)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    return consumer.resolve(platform)
  }
}

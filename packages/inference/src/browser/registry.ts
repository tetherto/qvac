// Browser replacement for handlers/load-model/registry.ts. The registry client
// downloads blobs from Hypercore over Hyperswarm, which cannot run in a
// browser: Hypercore 11 stores data through the native rocksdb addon and the
// DHT needs UDP. Registry models whose catalogued origin is Hugging Face are
// downloaded from that origin over HTTPS instead and verified against the
// catalog's SHA-256, so `loadModel({ modelSrc: QWEN3_600M_INST_Q4 })` works
// unchanged. Models stored in S3 reach clients only through the registry's
// peer-to-peer network (the S3 bucket itself is private), so they are rejected.
import fs from 'bare-fs'
import type { ModelProgressUpdate } from '@/schemas/index'
import type { DownloadHooks } from '@/handlers/load-model/types'
import type { ExplicitRegistryMetadata } from '@/handlers/load-model/registry-metadata'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import { getModelByPath } from '@/models/registry/index'
import { measureChecksum } from '@/utils/checksum'
import { ChecksumValidationFailedError, ModelLoadFailedError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

/** The Hugging Face download URL of an `hf` registry path (`blob` links become `resolve`). */
export function huggingFaceUrl(registryPath: string): string {
  const [owner, repo, kind, ...rest] = registryPath.split('/')
  return `https://huggingface.co/${owner}/${repo}/${kind === 'blob' ? 'resolve' : kind}/${rest.join('/')}`
}

// A verified download keeps `<size>:<sha256>` beside it, so later page loads
// skip re-hashing a multi-GB file the engine already checked.
function verifiedMarker(path: string): string {
  return `${path}.verified`
}

async function verify(
  path: string,
  expectedChecksum: string,
  hooks: DownloadHooks | undefined
): Promise<void> {
  const marker = verifiedMarker(path)
  const size = fs.statSync(path).size
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === `${size}:${expectedChecksum}`) {
    return
  }
  const started = Date.now()
  const actual = await measureChecksum(path, hooks)
  if (actual !== expectedChecksum) {
    await fs.promises.unlink(path).catch(() => {})
    throw new ChecksumValidationFailedError(path)
  }
  await fs.promises.writeFile(marker, `${size}:${expectedChecksum}`)
  logger.info(`Verified ${path} against the registry SHA-256 in ${Date.now() - started} ms`)
}

export async function downloadModelFromRegistry(
  registryPath: string,
  registrySource: string,
  progressCallback?: (progress: ModelProgressUpdate) => void,
  expectedChecksum?: string,
  hooks?: DownloadHooks,
  _explicitMetadata?: ExplicitRegistryMetadata
): Promise<string> {
  const metadata = getModelByPath(registryPath)
  if (registrySource !== 'hf') {
    throw new ModelLoadFailedError(
      `${metadata?.name ?? registryPath} is served only through the QVAC registry's ` +
        'peer-to-peer network, which browsers cannot join. Use a registry model hosted on ' +
        'Hugging Face, an HTTPS URL, or a local file.'
    )
  }
  if (metadata?.shardMetadata || metadata?.companionSet) {
    throw new ModelLoadFailedError(
      `${metadata.name} is a multi-file model, which the browser build does not support.`
    )
  }
  const url = huggingFaceUrl(registryPath)
  logger.info(`Registry model ${metadata?.name ?? registryPath}: downloading from ${url}`)
  const path = await downloadModelFromHttp(url, progressCallback, hooks)
  if (expectedChecksum) await verify(path, expectedChecksum, hooks)
  return path
}

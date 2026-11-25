import { promises as fsPromises } from 'bare-fs'
import { measureChecksum } from '@/utils/index'
import { getEngineLogger } from '@/logging/index'
import type { DownloadHooks } from '@/handlers/load-model/types'

const logger = getEngineLogger()

/**
 * Validate a cached file against expected size and checksum, warning with the
 * reason when an existing file is not used. Never deletes: a mismatched file may
 * be an older SDK's download in progress.
 */
export async function validateCachedFile(
  modelPath: string,
  modelFileName: string,
  expectedSize: number,
  expectedChecksum?: string,
  hooks?: DownloadHooks
): Promise<string | null> {
  let localSize: number
  try {
    localSize = (await fsPromises.stat(modelPath)).size
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      logger.warn(`Ignoring cached ${modelFileName} at ${modelPath}: ${describeError(error)}`)
    }
    return null
  }

  if (localSize !== expectedSize) {
    logger.warn(
      `Ignoring cached ${modelFileName} at ${modelPath}: size ${localSize}, expected ${expectedSize}`
    )
    return null
  }

  if (expectedChecksum && expectedChecksum.length === 64) {
    let checksum: string
    try {
      checksum = await measureChecksum(modelPath, hooks)
    } catch (error) {
      logger.warn(
        `Ignoring cached ${modelFileName} at ${modelPath}: checksum failed: ${describeError(error)}`
      )
      return null
    }
    if (checksum !== expectedChecksum) {
      logger.warn(
        `Ignoring cached ${modelFileName} at ${modelPath}: checksum ${checksum}, expected ${expectedChecksum}`
      )
      return null
    }
  }

  logger.info(`✅ Model already cached and validated: ${modelPath}`)
  return modelPath
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

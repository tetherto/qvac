import { promises as fsPromises } from 'bare-fs'
import { isHuggingFaceHost, measureChecksum } from '@/utils/index'
import { ChecksumUnavailableError, ChecksumValidationFailedError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'
import type { DownloadHooks } from '@/handlers/load-model/types'

const logger = getEngineLogger()

export function isHuggingFaceUrl(url: string): boolean {
  try {
    return isHuggingFaceHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Whether an HTTP download's transport must be secure (plaintext / HTTPS→HTTP
 * downgrades refused, loopback exempt). Hugging Face is always enforced so a
 * downgrade can't sidestep its Hub SHA-256 attestation; `requireSecureTransport`
 * extends the same enforcement to every HTTP source.
 */
export function shouldEnforceSecureTransport(
  url: string,
  requireSecureTransport: boolean
): boolean {
  return requireSecureTransport || isHuggingFaceUrl(url)
}

/**
 * Enforce the download integrity policy for a freshly downloaded HTTP file.
 *
 * A Hugging Face download carries the Hub's SHA-256 (captured from the resolve
 * hop), so it is always verified and a mismatch fails. When no trusted checksum
 * is available, the behavior depends on `requireChecksum`: a source that should
 * be verifiable (Hugging Face without a usable hash) is rejected under the flag;
 * a source with no checksum source at all (non-Hugging-Face) always downloads,
 * with a warning that it was unverified.
 */
export async function verifyHttpModelFile(
  url: string,
  filePath: string,
  hubSha256: string | undefined,
  requireChecksum: boolean,
  hooks?: DownloadHooks
): Promise<void> {
  if (hubSha256) {
    const actual = await measureChecksum(filePath, hooks)
    if (actual !== hubSha256) {
      await fsPromises.unlink(filePath).catch(() => {})
      logger.error(`❌ SHA-256 mismatch for ${url} (expected Hub ${hubSha256}, got ${actual})`)
      throw new ChecksumValidationFailedError(url)
    }
    logger.info(`✅ Verified ${url} against Hugging Face Hub SHA-256`)
    return
  }

  if (isHuggingFaceUrl(url)) {
    if (requireChecksum) {
      await fsPromises.unlink(filePath).catch(() => {})
      throw new ChecksumUnavailableError(url)
    }
    logger.warn(
      `⚠️ Integrity not verified: Hugging Face download exposes no Hub SHA-256 for ${url}`
    )
    return
  }

  // No trusted checksum to verify against. Allowed, but surfaced so it is never silent.
  logger.warn(`⚠️ Integrity not verified: no checksum available for ${url}`)
}

import fs from 'bare-fs'
import crypto from 'bare-crypto'
import path from 'bare-path'
import { nowMs } from '@/profiling/clock'
import type { DownloadHooks } from '@/handlers/load-model/types'
import { type Buffer } from 'bare-buffer'

export async function calculateFileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('sha-256')
      const stream = fs.createReadStream(filePath)

      stream.on('data', (chunk) => {
        hash.update(chunk as Buffer)
      })

      stream.on('end', () => {
        resolve(hash.digest('hex'))
      })

      stream.on('error', (error: Error) => {
        reject(new Error(`Checksum calculation error: ${error.message}`))
      })
    } catch (error) {
      reject(
        error instanceof Error ? error : new Error(`Checksum calculation error: ${String(error)}`)
      )
    }
  })
}

// Process-local only: a new engine process must establish its own verification.
// Bound retention so applications visiting many model paths do not grow forever.
const checksumCache = new Map<string, { fingerprint: string; checksum: string }>()
const MAX_CACHED_CHECKSUMS = 256

async function fileFingerprint(filePath: string): Promise<string | undefined> {
  const stats = await fs.promises.stat(filePath)
  const fields = [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]
  // Runtimes/filesystems without usable identity metadata always hash the file.
  if (!stats.isFile() || !stats.ino || !fields.every(Number.isFinite)) return undefined
  return fields.join(':')
}

/** Reuse a digest only while the file's identity and change metadata match. */
export async function calculateCachedFileChecksum(filePath: string): Promise<string> {
  const key = path.resolve(filePath)
  try {
    const before = await fileFingerprint(key)
    const cached = checksumCache.get(key)
    if (before !== undefined && cached?.fingerprint === before) return cached.checksum

    checksumCache.delete(key)
    const checksum = await calculateFileChecksum(key)
    const after = await fileFingerprint(key)
    if (before !== after) throw new Error(`File changed during checksum calculation: ${key}`)
    if (after !== undefined) {
      if (checksumCache.size >= MAX_CACHED_CHECKSUMS) {
        checksumCache.delete(checksumCache.keys().next().value!)
      }
      checksumCache.set(key, { fingerprint: after, checksum })
    }
    return checksum
  } catch (error) {
    checksumCache.delete(key)
    throw error
  }
}

/**
 * Rename a file, keeping its cached digest if it is unchanged since hashing; the
 * rename itself can update ctime, which would otherwise force a re-hash.
 */
export async function renameWithCachedChecksum(fromPath: string, toPath: string): Promise<void> {
  const from = path.resolve(fromPath)
  const to = path.resolve(toPath)
  const cached = checksumCache.get(from)
  const unchanged =
    cached !== undefined && cached.fingerprint === (await fileFingerprint(from).catch(() => null))
  checksumCache.delete(from)
  checksumCache.delete(to)

  await fs.promises.rename(from, to)

  if (!unchanged) return
  const after = await fileFingerprint(to).catch(() => undefined)
  if (after !== undefined) checksumCache.set(to, { fingerprint: after, checksum: cached.checksum })
}

export async function measureChecksum(filePath: string, hooks?: DownloadHooks): Promise<string> {
  const start = nowMs()
  const checksum = await calculateCachedFileChecksum(filePath)
  hooks?.addChecksumValidationTimeMs?.(nowMs() - start)
  return checksum
}

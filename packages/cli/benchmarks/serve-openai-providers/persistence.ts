import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BenchmarkConfig } from './types.ts'

export type ModelParityEvidence = {
  path: string
  bytes: number
  sha256: string
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export async function verifyModelParity(config: BenchmarkConfig): Promise<ModelParityEvidence> {
  const path = config.model_parity.gguf_path
  const stat = statSync(path)
  if (!stat.isFile()) {
    throw new TypeError(`GGUF is not a file: ${path}`)
  }

  const sha256 = await sha256File(path)
  const configuredSha256 = config.model_parity.sha256
  if (
    configuredSha256 === undefined ||
    configuredSha256.length !== sha256.length ||
    !timingSafeEqual(Buffer.from(configuredSha256, 'ascii'), Buffer.from(sha256, 'ascii'))
  ) {
    throw new TypeError(
      `GGUF SHA-256 mismatch: configured=${configuredSha256 ?? ''} actual=${sha256}`
    )
  }

  return { path, bytes: stat.size, sha256 }
}

export function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const dir = dirname(path)
  const tmpDir = mkdtempSync(join(dir, '.tmp-'))
  const tmpPath = join(tmpDir, 'payload.json')
  try {
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, path)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

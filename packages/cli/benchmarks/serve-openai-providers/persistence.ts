import { createHash, timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BenchmarkConfig } from './types.ts'

export type ModelParityEvidence = {
  path: string
  bytes: number
  sha256: string
}

async function readFileDigest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer
    hash.update(buffer)
    bytes += buffer.byteLength
  }
  return { bytes, sha256: hash.digest('hex') }
}

export async function sha256File(path: string): Promise<string> {
  return (await readFileDigest(path)).sha256
}

export async function verifyModelParity(config: BenchmarkConfig): Promise<ModelParityEvidence> {
  const path = config.model_parity.gguf_path
  const { bytes, sha256 } = await readFileDigest(path)
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

  return { path, bytes, sha256 }
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

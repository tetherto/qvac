import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { BenchmarkConfig, RawDocument, RawRunRecord, RunMetrics } from './types'

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

export function createSessionDir(base: string, date: Date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  const session = join(base, `session-${stamp}-${randomBytes(4).toString('hex')}`)
  mkdirSync(session, { recursive: false })
  return session
}

export function newRawDocument(
  config: BenchmarkConfig,
  sessionId: string,
  createdAt: string = new Date().toISOString()
): RawDocument {
  return {
    session_id: sessionId,
    created_at: createdAt,
    valid: true,
    invalid_reasons: [],
    orchestration_errors: [],
    config_snapshot: {
      generation: config.generation,
      ...(config.cooldown_seconds === undefined
        ? {}
        : { cooldown_seconds: config.cooldown_seconds }),
      ...(config.warmup_runs === undefined ? {} : { warmup_runs: config.warmup_runs }),
      ...(config.measured_runs === undefined ? {} : { measured_runs: config.measured_runs }),
      prompt_ids: config.prompt_ids,
      providers: config.providers.map((provider) => ({
        id: provider.id,
        base_url: provider.base_url,
        model: provider.model
      })),
      model_parity: config.model_parity
    },
    provider_order: [],
    parity: {},
    runs: []
  }
}

export function appendRun(
  rawPath: string,
  raw: RawDocument,
  run: RawRunRecord,
  write: (path: string, payload: unknown) => void = atomicWriteJson
): void {
  raw.runs.push(run)
  write(rawPath, raw)
}

export function metricsToJson(metrics: RunMetrics): Record<string, number | null> {
  return {
    ttft_ms: metrics.ttftMs,
    total_ms: metrics.totalMs,
    prompt_tokens: metrics.promptTokens,
    completion_tokens: metrics.completionTokens,
    client_output_tps: metrics.clientOutputTps,
    effective_prefill_tps: metrics.effectivePrefillTps
  }
}

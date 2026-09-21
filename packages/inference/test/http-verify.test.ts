import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'bare-crypto'
import {
  isHuggingFaceUrl,
  shouldEnforceSecureTransport,
  verifyHttpModelFile
} from '@/handlers/load-model/http-verify'
import { ChecksumUnavailableError, ChecksumValidationFailedError } from '@/errors/index'
import { ALL_LOG_ID } from '@/logging'
import {
  clearAllLoggingStreams,
  registerLoggingStream,
  unregisterLoggingStream
} from '@/runtime/logging-stream-registry'

const HF_URL = 'https://huggingface.co/org/repo/resolve/main/model.gguf'
const BYO_URL = 'https://mirror.example.com/model.gguf'

function writeTempFile(name: string, content: string) {
  const dir = path.join(os.cwd(), 'test', 'tmp-http-verify')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

function sha256Hex(content: string) {
  const hash = crypto.createHash('sha-256')
  hash.update(content)
  return hash.digest('hex')
}

function cleanup() {
  const dir = path.join(os.cwd(), 'test', 'tmp-http-verify')
  fs.rmSync(dir, { recursive: true, force: true })
}

async function rejects(
  t: { ok: (v: unknown, msg?: string) => void; fail: (msg?: string) => void },
  fn: () => Promise<unknown>,
  ErrClass: new (...args: never[]) => Error
) {
  try {
    await fn()
    t.fail(`expected ${ErrClass.name}`)
  } catch (err) {
    t.ok(err instanceof ErrClass, `threw ${ErrClass.name}`)
  }
}

test('shouldEnforceSecureTransport: HF always, non-HF only under requireSecureTransport', (t) => {
  // Hugging Face is always hardened, flag or not.
  t.ok(shouldEnforceSecureTransport(HF_URL, false))
  t.ok(shouldEnforceSecureTransport(HF_URL, true))
  // Bring-your-own is only hardened when the flag is on.
  t.absent(shouldEnforceSecureTransport(BYO_URL, false))
  t.ok(shouldEnforceSecureTransport(BYO_URL, true))
})

test('isHuggingFaceUrl: classifies hosts', (t) => {
  t.ok(isHuggingFaceUrl(HF_URL))
  t.ok(isHuggingFaceUrl('https://hf.co/org/repo/resolve/main/model.gguf'))
  t.absent(isHuggingFaceUrl(BYO_URL))
  t.absent(isHuggingFaceUrl('not a url'))
})

test('verifyHttpModelFile: matching Hub SHA-256 passes and keeps the file', async (t) => {
  t.teardown(cleanup)
  const content = 'model-bytes'
  const filePath = writeTempFile('match.gguf', content)
  await verifyHttpModelFile(HF_URL, filePath, sha256Hex(content), false)
  t.ok(fs.existsSync(filePath))
})

test('verifyHttpModelFile: mismatching Hub SHA-256 throws and deletes the file', async (t) => {
  t.teardown(cleanup)
  const filePath = writeTempFile('mismatch.gguf', 'model-bytes')
  await rejects(
    t,
    () => verifyHttpModelFile(HF_URL, filePath, sha256Hex('different-bytes'), false),
    ChecksumValidationFailedError
  )
  t.absent(fs.existsSync(filePath))
})

test('verifyHttpModelFile: HF without hash + requireChecksum throws ChecksumUnavailable', async (t) => {
  t.teardown(cleanup)
  const filePath = writeTempFile('hf-nohash.gguf', 'model-bytes')
  await rejects(
    t,
    () => verifyHttpModelFile(HF_URL, filePath, undefined, true),
    ChecksumUnavailableError
  )
  t.absent(fs.existsSync(filePath))
})

test('verifyHttpModelFile: HF without hash + no flag proceeds unverified', async (t) => {
  t.teardown(cleanup)
  const filePath = writeTempFile('hf-nohash-ok.gguf', 'model-bytes')
  await verifyHttpModelFile(HF_URL, filePath, undefined, false)
  t.ok(fs.existsSync(filePath))
})

test('verifyHttpModelFile: non-HF without hash proceeds under both flag states', async (t) => {
  t.teardown(cleanup)
  const a = writeTempFile('byo-strict.gguf', 'model-bytes')
  const b = writeTempFile('byo-lax.gguf', 'model-bytes')
  await verifyHttpModelFile(BYO_URL, a, undefined, true)
  await verifyHttpModelFile(BYO_URL, b, undefined, false)
  t.ok(fs.existsSync(a))
  t.ok(fs.existsSync(b))
})

test('unverified downloads emit a warning', async (t) => {
  t.teardown(cleanup)
  clearAllLoggingStreams()
  const warnings: string[] = []
  const handler = (level: string, _ns: string, message: string) => {
    if (level === 'warn') warnings.push(message)
  }
  registerLoggingStream(ALL_LOG_ID, handler)
  t.teardown(() => {
    unregisterLoggingStream(ALL_LOG_ID, handler)
    clearAllLoggingStreams()
  })

  const byo = writeTempFile('byo-warn.gguf', 'model-bytes')
  await verifyHttpModelFile(BYO_URL, byo, undefined, false)
  const hf = writeTempFile('hf-warn.gguf', 'model-bytes')
  await verifyHttpModelFile(HF_URL, hf, undefined, false)

  t.ok(
    warnings.some((w) => w.includes(BYO_URL)),
    'bring-your-own unverified download warned'
  )
  t.ok(
    warnings.some((w) => w.includes(HF_URL)),
    'hashless Hugging Face download warned'
  )
})

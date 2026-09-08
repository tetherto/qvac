import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'bare-crypto'
import { isConfigSet, setConfig } from '@/runtime/state'
import { downloadModelFromHttp } from '@/handlers/load-model/http'
import { safeFetch } from '@/handlers/load-model/safe-fetch'
import { InsecureModelSourceError } from '@/errors/index'

// Real network e2e for the download-only path: fetches a small single-file LFS
// GGUF from the Hub and asserts the on-disk bytes equal the Hub-attested
// SHA-256, exercising the redirect walk, X-Linked-Etag capture, and verify.

const QVAC_MODEL_URL =
  'https://huggingface.co/qvac/VisionPsy-Nano-460M-Flash-GGUFs/resolve/main/mmproj-visionpsy-nano-460m-flash-q8.gguf'
const QVAC_MODEL_SHA256 = 'bbb0691873a4e638f6928898b3c3be9a4730bd4ced301197726a4fcb549695d0'

const cacheDir = path.join(os.cwd(), 'test', 'tmp-hf-download')

function ensureConfig() {
  if (!isConfigSet()) setConfig({ cacheDirectory: cacheDir, loggerConsoleOutput: false })
}

function fileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha-256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

test('real HF single-file download verifies against the Hub SHA-256', async (t) => {
  fs.rmSync(cacheDir, { recursive: true, force: true })
  ensureConfig()
  t.teardown(() => fs.rmSync(cacheDir, { recursive: true, force: true }))

  const modelPath = await downloadModelFromHttp(QVAC_MODEL_URL)

  t.ok(fs.existsSync(modelPath), 'model file was written to cache')
  const actual = await fileSha256(modelPath)
  t.is(actual, QVAC_MODEL_SHA256, 'downloaded bytes match the Hub-attested SHA-256')
})

test('a plaintext Hugging Face URL is rejected (transport hardened for HF)', async (t) => {
  ensureConfig()
  try {
    await downloadModelFromHttp(QVAC_MODEL_URL.replace('https://', 'http://'))
    t.fail('expected InsecureModelSourceError')
  } catch (err) {
    t.ok(err instanceof InsecureModelSourceError, 'threw InsecureModelSourceError')
  }
})

test('rejects a server with an untrusted TLS certificate', async (t) => {
  // Confirms bare-https validates certs by default (bare-tls rejectUnauthorized).
  // Without this an active MITM could strip the Hub attestation on plaintext.
  try {
    const res = await safeFetch('https://self-signed.badssl.com/', { timeoutMs: 15_000 })
    res.body.destroy()
    t.fail('expected the TLS handshake to be rejected')
  } catch (err) {
    t.pass(`rejected untrusted certificate: ${err instanceof Error ? err.message : String(err)}`)
  }
})

test('per-call requireSecureTransport rejects a plaintext non-Hugging-Face source', async (t) => {
  ensureConfig()
  // 192.0.2.0/24 (RFC 5737) is non-routable: enforcement rejects it before any
  // connection, so no network is touched. Without the per-call flag this
  // bring-your-own plaintext source would be allowed.
  try {
    await downloadModelFromHttp('http://192.0.2.1/model.gguf', undefined, undefined, {
      requireSecureTransport: true
    })
    t.fail('expected InsecureModelSourceError')
  } catch (err) {
    t.ok(err instanceof InsecureModelSourceError, 'threw InsecureModelSourceError')
  }
})

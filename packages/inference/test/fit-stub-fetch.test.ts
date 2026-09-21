import test from 'brittle'
import crypto from 'bare-crypto'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

import type { AbortSignal } from 'bare-abort-controller'

import {
  fetchFitStub,
  type FitBlobBinding,
  type FitStubEntry,
  type FitStubRef
} from '@/resources/model-fit/fit-stub/fetch-fit-stub'

const REF: FitStubRef = {
  name: 'Llama-3.2-1B-Instruct-Q4_0',
  sha256Checksum: 'a'.repeat(64),
  registryPath: 'models/llama-3.2-1b',
  registrySource: 'huggingface'
}

const STUB_BYTES = Buffer.from('GGUF' + 'x'.repeat(28))

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha-256').update(bytes).digest('hex')
}

const BINDING: FitBlobBinding = {
  coreKey: 'c'.repeat(64),
  blockOffset: 0,
  blockLength: 1,
  byteOffset: 0,
  byteLength: STUB_BYTES.length,
  sha256: sha256(STUB_BYTES)
}

const ENTRY: FitStubEntry = { fitBlobBinding: BINDING }

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fit-stub-'))
}

// Stands in for the registry writing the blob to the path it was handed.
function writesStub(bytes: Buffer = STUB_BYTES) {
  const calls: string[] = []
  return {
    calls,
    downloadBlob: async (_binding: FitBlobBinding, outputFile: string) => {
      calls.push(outputFile)
      fs.writeFileSync(outputFile, bytes)
    }
  }
}

test('a ref with no registry coordinates is unresolvable', async function (t) {
  const res = await fetchFitStub(
    { name: 'local', sha256Checksum: 'c'.repeat(64) },
    { cacheDir: tempDir(), getEntry: async () => ENTRY }
  )

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') t.is(res.reason, 'unresolvable-ref')
})

test('a record the registry does not have is not an error', async function (t) {
  const res = await fetchFitStub(REF, { cacheDir: tempDir(), getEntry: async () => null })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') t.is(res.reason, 'not-in-registry')
})

// The field is optional on the record: an artifact ingested before fit blobs
// existed, or one whose description could not be built, simply has none.
test('an entry without a fit blob is not an error', async function (t) {
  const res = await fetchFitStub(REF, { cacheDir: tempDir(), getEntry: async () => ({}) })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') t.is(res.reason, 'no-fit-blob')
})

test('a fit stub is fetched into its own directory and named by its digest', async function (t) {
  const cacheDir = tempDir()
  const downloader = writesStub()

  const res = await fetchFitStub(REF, {
    cacheDir,
    getEntry: async () => ENTRY,
    downloadBlob: downloader.downloadBlob
  })

  t.is(res.status, 'ready')
  if (res.status !== 'ready') return

  t.is(path.basename(res.path), `${BINDING.sha256}.gguf`, 'named by the blob digest')
  t.is(path.dirname(path.dirname(res.path)), cacheDir, 'staged one directory below the root')
  t.is(res.bytes, STUB_BYTES.length)
  t.alike(fs.readFileSync(res.path), STUB_BYTES, 'the bytes landed')
  t.alike(downloader.calls, [res.path], 'downloaded straight to the returned path')
})

// Two assessments of the same model must never share a file that one of them
// is about to remove.
test('two fetches of the same stub do not share a path', async function (t) {
  const cacheDir = tempDir()
  const options = { cacheDir, getEntry: async () => ENTRY, downloadBlob: writesStub().downloadBlob }

  const [a, b] = await Promise.all([fetchFitStub(REF, options), fetchFitStub(REF, options)])

  t.is(a.status, 'ready')
  t.is(b.status, 'ready')
  if (a.status === 'ready' && b.status === 'ready') t.not(a.path, b.path)
})

test('a failed download reports rather than throwing, and leaves nothing behind', async function (t) {
  const cacheDir = tempDir()

  const res = await fetchFitStub(REF, {
    cacheDir,
    getEntry: async () => ENTRY,
    downloadBlob: async (_binding, outputFile) => {
      fs.writeFileSync(outputFile, Buffer.from('half'))
      throw new Error('peer went away')
    }
  })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') {
    t.is(res.reason, 'download-failed')
    t.ok(res.message?.includes('peer went away'), 'the cause is carried')
  }
  t.alike(fs.readdirSync(cacheDir), [], 'the staging directory is gone')
})

test('a stub that does not match the recorded length is rejected', async function (t) {
  const cacheDir = tempDir()

  const res = await fetchFitStub(REF, {
    cacheDir,
    getEntry: async () => ENTRY,
    downloadBlob: writesStub(Buffer.from('GGUF')).downloadBlob
  })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') {
    t.is(res.reason, 'download-failed')
    t.ok(res.message?.includes('the record says'), 'the mismatch is named')
  }
  t.alike(fs.readdirSync(cacheDir), [], 'the short stub is not kept')
})

// Right length, wrong bytes: only the digest the record binds can tell.
test('a stub that does not match the recorded digest is rejected', async function (t) {
  const cacheDir = tempDir()
  const corrupt = Buffer.from('GGUF' + 'y'.repeat(28))

  const res = await fetchFitStub(REF, {
    cacheDir,
    getEntry: async () => ENTRY,
    downloadBlob: writesStub(corrupt).downloadBlob
  })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') {
    t.is(res.reason, 'download-failed')
    t.ok(res.message?.includes('hashes to'), 'the digest mismatch is named')
  }
  t.alike(fs.readdirSync(cacheDir), [], 'the corrupt stub is not kept')
})

function settle(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

// The download timeout alone leaves the lookup unbounded: a cold worker joins
// the swarm and waits for the registry view before `getModel` answers.
test('a registry lookup that does not answer within the budget times out', async function (t) {
  const cacheDir = tempDir()
  const started = Date.now()

  const res = await fetchFitStub(REF, {
    cacheDir,
    budgetMs: 50,
    getEntry: () => new Promise(() => {})
  })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') t.is(res.reason, 'timed-out')
  t.ok(Date.now() - started < 2_000, 'returned on the budget, not on the lookup')
  t.alike(fs.readdirSync(cacheDir), [], 'nothing was staged')
})

test('a download that outlives the budget is aborted and leaves nothing behind', async function (t) {
  const cacheDir = tempDir()
  let aborted = false

  const res = await fetchFitStub(REF, {
    cacheDir,
    budgetMs: 50,
    getEntry: async () => ENTRY,
    downloadBlob: (_binding, outputFile, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        fs.writeFileSync(outputFile, Buffer.from('half'))
        signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('Download cancelled'))
        })
      })
  })

  t.is(res.status, 'unavailable')
  if (res.status === 'unavailable') t.is(res.reason, 'timed-out')
  t.ok(aborted, 'the download was told to stop')
  await settle(20)
  t.alike(fs.readdirSync(cacheDir), [], 'the half-written stub is gone')
})

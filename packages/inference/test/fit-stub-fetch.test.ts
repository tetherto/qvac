import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'

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

const BINDING: FitBlobBinding = { sha256: 'b'.repeat(64), byteLength: STUB_BYTES.length }

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

test('a fit stub is fetched and named by its own digest', async function (t) {
  const cacheDir = tempDir()
  const downloader = writesStub()

  const res = await fetchFitStub(REF, {
    cacheDir,
    getEntry: async () => ENTRY,
    downloadBlob: downloader.downloadBlob
  })

  t.is(res.status, 'ready')
  if (res.status !== 'ready') return

  t.is(res.path, path.join(cacheDir, `${BINDING.sha256}.gguf`), 'keyed by the blob digest')
  t.is(res.bytes, STUB_BYTES.length)
  t.is(res.cached, false)
  t.alike(fs.readFileSync(res.path), STUB_BYTES, 'the bytes landed')
  t.absent(fs.existsSync(`${res.path}.part`), 'no partial file is left behind')
})

test('a stub already in the cache is not downloaded again', async function (t) {
  const cacheDir = tempDir()
  const downloader = writesStub()
  const options = {
    cacheDir,
    getEntry: async () => ENTRY,
    downloadBlob: downloader.downloadBlob
  }

  await fetchFitStub(REF, options)
  const second = await fetchFitStub(REF, options)

  t.is(second.status, 'ready')
  if (second.status === 'ready') t.is(second.cached, true)
  t.is(downloader.calls.length, 1, 'the blob was fetched once')
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
  t.alike(fs.readdirSync(cacheDir), [], 'the cache is left clean')
})

// The size check is what stops a truncated fetch being cached and then trusted
// by the `cached` branch on every later call.
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

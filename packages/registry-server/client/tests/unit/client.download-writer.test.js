'use strict'

const test = require('brittle')
const tmp = require('test-tmp')
const fs = require('#fs')
const path = require('#path')
const Corestore = require('corestore')
const Hyperblobs = require('hyperblobs')
const QVACRegistryClient = require('../../lib/client')

for (const method of ['downloadModel', 'downloadBlob']) {
  test(`${method} waits for the cancelled file writer to close`, async (t) => {
    const root = await tmp(t)
    const outputFile = path.join(root, 'model.part')
    const store = new Corestore(path.join(root, 'store'))
    t.teardown(() => store.close())
    const core = store.get({ name: 'blobs' })
    await core.ready()
    const blobs = new Hyperblobs(core)
    await blobs.ready()
    const binding = { coreKey: core.key, ...(await blobs.put(Buffer.alloc(65536, 1))) }

    const client = Object.create(QVACRegistryClient.prototype)
    client.logger = { info() {}, debug() {}, warn() {}, error() {} }
    client.ready = () => Promise.resolve()
    client._ensureMetadata = () => Promise.resolve()
    client.getModel = () => Promise.resolve({ name: 'writer-test', blobBinding: binding })
    client._getBlobsCore = () => Promise.resolve({ core, blobs })
    client.hyperswarm = { join() {}, flush: () => Promise.resolve() }

    let onAbort
    const signal = {
      aborted: false,
      addEventListener(event, listener) {
        if (event === 'abort') onAbort = listener
      },
      removeEventListener(event, listener) {
        if (event === 'abort' && onAbort === listener) onAbort = null
      }
    }

    let releaseWrite
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve
    })
    let startedWrite
    const writeStarted = new Promise((resolve) => {
      startedWrite = resolve
    })
    let writerClosed = false
    const createWriteStream = fs.createWriteStream
    t.teardown(() => {
      fs.createWriteStream = createWriteStream
      releaseWrite()
    })
    fs.createWriteStream = function (file, options) {
      if (file !== outputFile) return createWriteStream.call(this, file, options)
      const delayedFs = { ...fs }
      for (const name of ['write', 'writev']) {
        delayedFs[name] = function (...args) {
          startedWrite()
          writeGate.then(() => fs[name](...args))
        }
      }
      const writer = createWriteStream.call(this, file, { ...options, fs: delayedFs })
      // bare-fs has no fs option; streamx keeps _writev pending until its callback.
      if (globalThis.Bare) {
        const write = writer._writev
        writer._writev = function (...args) {
          startedWrite()
          writeGate.then(() => write.apply(this, args))
        }
      }
      writer.once('close', () => {
        writerClosed = true
      })
      return writer
    }

    const options = { outputFile, signal, maxRetries: 1, clearBlocksOnCancel: false }
    let settled = false
    const download = (
      method === 'downloadModel'
        ? client.downloadModel('models/writer-test.gguf', 's3', options)
        : client.downloadBlob(binding, options)
    ).then(
      () => {
        settled = true
        return null
      },
      (error) => {
        settled = true
        return error
      }
    )

    await Promise.race([
      writeStarted,
      download.then((error) => {
        throw error || new Error('download ended before writing')
      })
    ])
    signal.aborted = true
    onAbort()
    await new Promise((resolve) => setTimeout(resolve, 50))
    t.is(settled, false, 'cancellation cannot release the caller while a write is held')
    t.is(writerClosed, false, 'the real writer is still open')

    releaseWrite()
    const error = await download
    t.is(error?.message, 'Download cancelled', 'preserves the cancellation error')
    t.is(writerClosed, true, 'the writer is closed before the caller receives cancellation')
    const replacement = Buffer.from('replacement download')
    await fs.promises.writeFile(outputFile, replacement)
    t.alike(
      await fs.promises.readFile(outputFile),
      replacement,
      'the next download can replace the file'
    )
  })
}

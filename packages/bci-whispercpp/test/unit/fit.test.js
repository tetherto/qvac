'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const { assessFit } = require('../../index.js')

function tempFile(t, name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bci-fit-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, contents)
  return filePath
}

test('an unreadable model returns an error outcome', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.bin' })

  t.is(fit.status, 'error')
  t.is(fit.reason, 'model-unreadable')
})

test('a file that is not a model is unreadable too', (t) => {
  const filePath = tempFile(t, 'model.bin', Buffer.alloc(512, 7))

  const fit = assessFit({ modelPath: filePath })

  t.is(fit.status, 'error')
})

test('the embedder is sized from disk and left out of the projection', (t) => {
  const embedderPath = tempFile(t, 'bci-embedder.bin', Buffer.alloc(2048, 1))

  const withEmbedder = assessFit({
    modelPath: '/nonexistent/model.bin',
    embedderPath
  })
  const withoutEmbedder = assessFit({ modelPath: '/nonexistent/model.bin' })

  t.is(withEmbedder.embedderFileBytes, 2048)
  t.is(withoutEmbedder.embedderFileBytes, 0)
  t.is(withEmbedder.deviceBytes, withoutEmbedder.deviceBytes)
  t.is(withEmbedder.hostBytes, withoutEmbedder.hostBytes)
})

test('an embedder path that does not exist reports zero', (t) => {
  const fit = assessFit({
    modelPath: '/nonexistent/model.bin',
    embedderPath: '/nonexistent/bci-embedder.bin'
  })

  t.is(fit.embedderFileBytes, 0)
})

test('every projected field is present on an unreadable model', (t) => {
  const fit = assessFit({ modelPath: '/nonexistent/model.bin' })

  for (const key of [
    'deviceBytes',
    'weightsBytes',
    'kvBytes',
    'computeBytes',
    'hostOverflowBytes',
    'hostBytes',
    'deviceFreeBytes',
    'deviceTotalBytes',
    'embedderFileBytes'
  ]) {
    t.is(typeof fit[key], 'number', key)
  }
  t.is(typeof fit.deviceIsCpu, 'boolean')
  t.is(typeof fit.deviceSharesHostMemory, 'boolean')
  t.is(typeof fit.report, 'string')
})

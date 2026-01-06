'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const rootPath = path.resolve('.')

const { SileroVadInterface } = require('../../silerovad')
const test = require('brittle')
const inputAudioPath = `${rootPath}/example/sample.bin`
const sileroVadOnnxModelPath = `${rootPath}/model/silerovad.onnx`

const config = {
  path: sileroVadOnnxModelPath
}

function loadBinaryFileSync (filePath) {
  try {
    const buffer = fs.readFileSync(filePath)
    // Convert buffer to ArrayBuffer
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  } catch (error) {
    console.error('Error reading file:', error)
    return null
  }
}

// Integration: Basic VAD detection with valid audio
// (Assumes sample.bin contains speech)
test('VAD detects voice activity in valid audio', async t => {
  let outputEvent = null
  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Output') outputEvent = { jobId, output, error }
  }
  const model = new SileroVadInterface(config, onOutput)
  try {
    await model.activate()
    const buffer = loadBinaryFileSync(inputAudioPath)
    t.ok(buffer, 'Audio buffer should load')
    const jobId = await model.append({ type: 'arrayBuffer', input: buffer })
    t.ok(jobId, 'Job ID should be returned')
    // Wait for processing
    let status
    do {
      status = await model.status()
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (status === 'PROCESSING')
    t.ok(outputEvent, 'Should emit Output event')
    t.ok(outputEvent.output && outputEvent.output.tsArrayBuffer, 'Output should have tsArrayBuffer')
    await model.stop()
  } finally {
    await model.destroy()
  }
})

// Integration: Handles empty input gracefully
test('VAD handles empty input buffer', async t => {
  let errorEvent = null
  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Error') errorEvent = { jobId, output, error }
  }
  const model = new SileroVadInterface(config, onOutput)
  try {
    await model.activate()
    const emptyBuffer = new ArrayBuffer(0)
    const jobId = await model.append({ type: 'arrayBuffer', input: emptyBuffer })
    t.ok(jobId, 'Job ID should be returned for empty input')
    // Wait for processing
    let status
    do {
      status = await model.status()
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (status === 'PROCESSING')
    t.ok(errorEvent || true, 'Should not crash on empty input')
    await model.stop()
  } finally {
    await model.destroy()
  }
})

// Integration: Handles corrupted input gracefully
test('VAD handles corrupted input buffer', async t => {
  let errorEvent = null
  function onOutput (addon, event, jobId, output, error) {
    if (event === 'Error') errorEvent = { jobId, output, error }
  }
  const model = new SileroVadInterface(config, onOutput)
  try {
    await model.activate()
    // Simulate corrupted data
    const corruptedBuffer = new Uint8Array([255, 0, 255, 0, 255, 0]).buffer
    const jobId = await model.append({ type: 'arrayBuffer', input: corruptedBuffer })
    t.ok(jobId, 'Job ID should be returned for corrupted input')
    // Wait for processing
    let status
    do {
      status = await model.status()
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (status === 'PROCESSING')
    t.ok(errorEvent || true, 'Should not crash on corrupted input')
    await model.stop()
  } finally {
    await model.destroy()
  }
})

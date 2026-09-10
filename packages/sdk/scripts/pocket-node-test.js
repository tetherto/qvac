// Run after building @qvac/inference and @qvac/sdk and resolving import aliases.
// Exercises the normal Node SDK transport and its spawned Bare worker.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundleInput = process.env['QVAC_POCKET_MODEL_DIR']
if (!bundleInput) {
  throw new Error('QVAC_POCKET_MODEL_DIR is required; this test must not skip inference')
}
const bundle = path.resolve(bundleInput)
const build = path.join(root, 'dist/src')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-pocket-node-'))
process.env['QVAC_WORKER_PATH'] = path.join(root, 'scripts/pocket-test-worker.js')
process.env['QVAC_POCKET_TEST_HOME'] = home
process.env['QVAC_CONFIG_PATH'] = path.join(home, 'qvac.config.json')
fs.writeFileSync(
  process.env['QVAC_CONFIG_PATH'],
  JSON.stringify({ cacheDirectory: path.join(home, 'cache') })
)
fs.writeFileSync(
  path.join(home, 'package.json'),
  JSON.stringify({ name: 'pocket-ipc-test', private: true })
)
process.chdir(home)
const load = (name) => import(pathToFileURL(path.join(build, name)).href)
const { loadModel, unloadModel, textToSpeech, textToSpeechStream, cancel, close } =
  await load('index.js')
const { getWorkerLifeSignal } = await load('client/rpc/node-rpc-client.js')
const { ModelType } = await import('@qvac/inference/surface')

test('Pocket public Node client over worker IPC', { timeout: 60000 }, async (t) => {
  // Node's test timeout does not unwind a hung await into finally.
  // Register teardown before load so cancellation also closes its worker.
  let shutdownPromise
  const shutdown = () => (shutdownPromise ??= close())
  const onAbort = () => {
    void shutdown().catch((error) => {
      console.error('Pocket IPC shutdown failed', error)
      process.exitCode = 1
    })
  }
  t.signal.addEventListener('abort', onAbort, { once: true })
  t.after(async () => {
    t.signal.removeEventListener('abort', onAbort)
    await shutdown()
  })
  const modelId = await loadModel({
    modelType: ModelType.ttsGgml,
    modelSrc: path.join(bundle, 'flow-lm.gguf'),
    modelConfig: {
      ttsEngine: 'pocket',
      language: 'en',
      useGPU: false,
      threads: 1,
      temperature: 0,
      mimiModelSrc: path.join(bundle, 'mimi.gguf'),
      frontendSrc: path.join(bundle, 'frontend.json'),
      voiceSrc: path.join(bundle, 'voice.gguf'),
      outputSampleRate: 24000
    }
  })
  assert.ok(modelId)
  const text = 'Hello! Pocket TTS now speaks through the Fabric client.'
  let reference
  await t.test('batch and stream preserve PCM across serialization', async () => {
    const batch = textToSpeech({ modelId, text, stream: false })
    reference = await batch.buffer
    assert.equal(await batch.done, true)
    assert.ok(reference.length > 24000 && reference.some((sample) => sample !== 0))
    const stream = textToSpeech({ modelId, text, stream: true })
    const pcm = []
    for await (const sample of stream.bufferStream) pcm.push(sample)
    assert.equal(await stream.done, true)
    assert.equal(pcm.length, reference.length)
    assert.ok(pcm.every((sample, i) => Math.abs(sample - reference[i]) <= 4))
  })
  await t.test('duplex emits audio while text input is still open', async () => {
    const session = await textToSpeechStream({
      modelId,
      inputType: 'text',
      accumulateSentences: false
    })
    try {
      session.write('Hello from Pocket. ')
      const iterator = session[Symbol.asyncIterator]()
      let samples = 0
      while (!samples) {
        const next = await iterator.next()
        assert.equal(next.done, false)
        samples += next.value.buffer.length
      }
      session.end()
      while (!(await iterator.next()).done) {
        /* drain */
      }
      assert.ok(samples > 0)
    } finally {
      session.destroy()
    }
  })
  await t.test('cancel terminates an active stream and permits recovery', async () => {
    const response = textToSpeech({
      modelId,
      text: text.repeat(10),
      stream: true
    })
    const iterator = response.bufferStream[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      assert.equal(next.done, false)
      if (next.value !== 0) break
    }
    await cancel({ modelId, kind: 'tts' })
    try {
      while (!(await iterator.next()).done) {
        /* drain queued samples */
      }
    } catch (error) {
      assert.match(String(error), /cancel|abort/i)
    }
    assert.equal(await response.done.catch(() => false), false)
    const recovered = textToSpeech({ modelId, text, stream: false })
    const pcm = await recovered.buffer
    assert.equal(await recovered.done, true)
    assert.equal(pcm.length, reference.length)
    assert.ok(pcm.every((sample, i) => Math.abs(sample - reference[i]) <= 4))
  })
  await unloadModel({ modelId, autoClose: false })
  const life = getWorkerLifeSignal()
  assert.ok(life && !life.aborted)
  await close()
  assert.equal(life.aborted, true, 'closing the client ends its worker lifecycle')
})

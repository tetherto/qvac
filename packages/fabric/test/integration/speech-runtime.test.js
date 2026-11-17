'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { Readable } = require('bare-stream')
const { ensureModel } = require('./download')

const speechFirst = process.argv.includes('speech-first')
const device = process.env.QVAC_TEST_DEVICE || 'cpu'
const TIMEOUT_MS = 15 * 60 * 1000
const LLM_MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}
const SPEECH_MODEL = {
  name: 'ggml-tiny.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin'
}

function loadSpeechPackages() {
  require('@qvac/tts-ggml')
  require('@qvac/audiogen-ggml')
  require('@qvac/bci-whispercpp')
  return require('@qvac/asr-ggml')
}

function loadPackages() {
  if (speechFirst) {
    const ASR = loadSpeechPackages()
    return { ASR, LLM: require('@qvac/llm-llamacpp') }
  }
  const LLM = require('@qvac/llm-llamacpp')
  return { LLM, ASR: loadSpeechPackages() }
}

async function complete(model) {
  const response = await model.run([{ role: 'user', content: 'Say hello.' }])
  const chunks = []
  await response.onUpdate((chunk) => chunks.push(chunk)).await()
  return chunks.join('').trim()
}

async function transcribe(model) {
  const audio = fs.readFileSync(
    path.resolve(__dirname, '../../../asr-ggml/examples/samples/sample.raw')
  )
  const response = await model.run(Readable.from([new Uint8Array(audio)]))
  const segments = []
  await response
    .onUpdate((output) => segments.push(...(Array.isArray(output) ? output : [output])))
    .await()
  return segments
    .map((segment) => segment.text || '')
    .join('')
    .trim()
}

function runtimeFiles() {
  const paths = fs
    .readFileSync('/proc/self/maps', 'utf8')
    .split('\n')
    .map((line) => line.slice(line.indexOf('/')))
  return [...new Set(paths.filter((file) => /qvac__fabric-[^/]+\.bare$/.test(file)))]
}

async function loadModels(llm, speech) {
  if (speechFirst) {
    await speech.load()
    await llm.load()
  } else {
    await llm.load()
    await speech.load()
  }
}

test(
  `speech and LLM share Fabric: ${speechFirst ? 'speech-first' : 'llm-first'}`,
  { timeout: TIMEOUT_MS },
  async (t) => {
    const { LLM, ASR } = loadPackages()
    const [llmPath, speechPath] = await Promise.all([
      ensureModel(LLM_MODEL),
      ensureModel(SPEECH_MODEL)
    ])
    const llm = new LLM({
      files: { model: [llmPath] },
      config: {
        device,
        gpu_layers: device === 'cpu' ? '0' : '999',
        ctx_size: '1024',
        n_predict: '16'
      }
    })
    const speech = new ASR({
      files: { model: speechPath },
      config: {
        engine: 'whisper',
        contextParams: { use_gpu: device !== 'cpu' },
        whisperConfig: { language: 'en', n_threads: 2 }
      }
    })
    try {
      await loadModels(llm, speech)
      const [completion, transcript] = await Promise.all([complete(llm), transcribe(speech)])
      t.ok(completion.length > 0, 'concurrent LLM inference produces text')
      t.ok(transcript.length > 0, 'concurrent speech inference produces text')
      await speech.unload()
      t.ok((await complete(llm)).length > 0, 'LLM survives speech unload')
      await speech.load()
      await llm.unload()
      t.ok((await transcribe(speech)).length > 0, 'speech survives LLM unload')
      await llm.load()
      t.ok((await complete(llm)).length > 0, 'LLM reloads after speech initialization')
      if (process.platform === 'linux') t.is(runtimeFiles().length, 1, 'one mapped Fabric runtime')
    } finally {
      await Promise.allSettled([llm.unload(), speech.unload()])
    }
  }
)

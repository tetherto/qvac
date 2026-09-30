'use strict'

const test = require('brittle')
const path = require('bare-path')
const TTSGgml = require('../../index.js')
const { TTSInterface } = require('../../tts.js')
const MockedBinding = require('../mock/MockedBinding.js')
const process = require('bare-process')

global.process = process

const SPEECH_MODEL = './models/moss-speech-q8_0.gguf'
const SPEECH_CODEC = './models/moss-speech-codec-f16.gguf'
const BACKBONE = './models/moss-tts-delay-f16.gguf'
const DECODER = './models/moss-codec-decoder-f16.gguf'
const NATIVE_RATE = 24000
const QUESTION_RATE = 16000
const REPLY_TEXT = 'The capital of France is Paris.'
const REPLY_SAMPLES = 480

function question() {
  return new Int16Array(1600).fill(1000)
}

class SpeechBinding extends MockedBinding {
  constructor(opts) {
    super(opts)
    this.jobs = []
  }

  runJob(handle, data) {
    if (handle !== this._handle) throw new Error('Invalid handle')
    this.jobs.push(data)
    setTimeout(() => {
      const pcm = data.textReply ? new Int16Array(0) : new Int16Array(REPLY_SAMPLES).fill(500)
      this._callCallbacks(
        'AudioResult',
        { outputArray: pcm, sampleRate: NATIVE_RATE, text: REPLY_TEXT },
        null
      )
      this._callCallbacks(
        'RuntimeStats',
        { totalTime: 0.2, realTimeFactor: 0.5, audioDurationMs: 20, totalSamples: pcm.length },
        null
      )
    }, this._jobDelayMs)
    return true
  }
}

function createMockedSpeechModel({ binding, files, extra = {} } = {}) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS_SPEECH,
    files: files || { mossSpeechModel: SPEECH_MODEL, mossSpeechCodec: SPEECH_CODEC },
    opts: { stats: true },
    ...extra
  })
  model._createAddon = (configurationParams, outputCb) =>
    new TTSInterface(binding || new SpeechBinding(), configurationParams, outputCb)
  return model
}

function withTempDir(name, body) {
  const fs = require('bare-fs')
  const os = require('bare-os')
  const root = path.join(os.tmpdir(), `${name}-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  try {
    return body(root, fs)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch (_e) {}
  }
}

async function runRecorded(fields) {
  const binding = new SpeechBinding()
  const model = createMockedSpeechModel({ binding })
  await model.load()
  const updates = []
  const response = await model.run({ type: 'text', input: '', ...fields })
  await response.onUpdate((chunk) => updates.push(chunk)).await()
  await model.unload()
  return { jobs: binding.jobs, updates }
}

async function expectEachRejected(t, model, cases) {
  for (const [fields, pattern] of cases) {
    await t.exception(model.run({ type: 'text', input: '', ...fields }), pattern)
  }
}

test('MOSS-Speech: explicit engine option routes to moss-speech', (t) => {
  const model = createMockedSpeechModel()
  t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS_SPEECH)
  t.is(model._mossSpeechModelPath, SPEECH_MODEL)
  t.is(model._mossSpeechCodecPath, SPEECH_CODEC)
})

test('MOSS-Speech: the model files alone route to moss-speech, under either alias', (t) => {
  const plain = new TTSGgml({
    files: { mossSpeechModel: SPEECH_MODEL, mossSpeechCodec: SPEECH_CODEC }
  })
  t.is(plain.getEngineType(), TTSGgml.ENGINE_MOSS_SPEECH)
  const aliased = new TTSGgml({
    files: { mossSpeechModelPath: SPEECH_MODEL, mossSpeechCodecPath: SPEECH_CODEC }
  })
  t.is(aliased.getEngineType(), TTSGgml.ENGINE_MOSS_SPEECH)
  t.is(aliased._mossSpeechCodecPath, SPEECH_CODEC)
})

test('MOSS-Speech: modelDir detection pairs the model with its codec and prefers q8_0', (t) => {
  withTempDir('tts-ggml-moss-speech-detect', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-speech-bf16.gguf'), 'bf16')
    fs.writeFileSync(path.join(root, 'moss-speech-q8_0.gguf'), 'q8')
    fs.writeFileSync(path.join(root, 'moss-speech-codec-f16.gguf'), 'codec')
    const model = new TTSGgml({ files: { modelDir: root } })
    t.is(model.getEngineType(), TTSGgml.ENGINE_MOSS_SPEECH)
    t.is(model._mossSpeechModelPath, path.join(root, 'moss-speech-q8_0.gguf'))
    t.is(model._mossSpeechCodecPath, path.join(root, 'moss-speech-codec-f16.gguf'))
  })
})

test('MOSS-Speech: ttsParams carry both files and the runtime options', (t) => {
  const model = createMockedSpeechModel({
    extra: { seed: 7, threads: 2, config: { useGPU: true }, backendsDir: '/opt/backends' }
  })
  const params = model._buildTtsParams()
  t.is(params.engineType, TTSGgml.ENGINE_MOSS_SPEECH)
  t.is(params.mossSpeechModelPath, SPEECH_MODEL)
  t.is(params.mossSpeechCodecPath, SPEECH_CODEC)
  t.is(params.seed, 7)
  t.is(params.threads, 2)
  t.is(params.useGPU, true)
  t.ok(String(params.backendsDir).startsWith('/opt/backends'))
})

test('MOSS-Speech: construction needs both GGUFs', (t) => {
  withTempDir('tts-ggml-moss-speech-empty', (root, fs) => {
    fs.writeFileSync(path.join(root, 'moss-speech-q8_0.gguf'), 'q8')
    t.exception(
      () => new TTSGgml({ engine: TTSGgml.ENGINE_MOSS_SPEECH, files: { modelDir: root } }),
      /moss-speech engine needs its model and codec GGUFs/
    )
  })
})

test('MOSS-Speech: constructor rejects what the engine cannot do', (t) => {
  t.exception(
    () =>
      createMockedSpeechModel({
        extra: {
          files: {
            mossSpeechModel: SPEECH_MODEL,
            mossSpeechCodec: SPEECH_CODEC,
            lavasrEnhancer: '/e.gguf'
          }
        }
      }),
    /LavaSR enhancer\/denoiser are not supported with the moss-speech engine/
  )
  t.exception(
    () => createMockedSpeechModel({ extra: { referenceAudio: '/abs/voice.wav' } }),
    /takes its reply voice per call/
  )
  t.exception(
    () => createMockedSpeechModel({ extra: { config: { outputSampleRate: 16000 } } }),
    /moss-speech engine outputs 24000 Hz/
  )
  t.exception(
    () => createMockedSpeechModel({ extra: { streamChunkTokens: 25 } }),
    /not supported by the moss-speech engine/
  )
})

test('MOSS-Speech: a spoken question becomes the user message', async (t) => {
  const audio = question()
  const { jobs, updates } = await runRecorded({ audio, sampleRate: QUESTION_RATE })
  t.is(jobs.length, 1)
  t.alike(jobs[0].messages, [{ role: 'user', audio, sampleRate: QUESTION_RATE }])
  t.is(updates[0].text, REPLY_TEXT, 'the reply text reaches the caller')
  t.is(updates[0].outputArray.length, REPLY_SAMPLES)
  t.is(updates[0].sampleRate, NATIVE_RATE)
})

test('MOSS-Speech: a text question, history and system prompt are folded in order', async (t) => {
  const earlier = { role: 'user', audio: question(), sampleRate: QUESTION_RATE }
  const answer = { role: 'assistant', text: 'Sure.' }
  const { jobs } = await runRecorded({
    input: 'And why is it famous?',
    messages: [earlier, answer],
    systemPrompt: 'Answer briefly.'
  })
  t.alike(jobs[0].messages, [
    { role: 'system', text: 'Answer briefly.' },
    earlier,
    answer,
    { role: 'user', text: 'And why is it famous?' }
  ])
})

test('MOSS-Speech: reply voice and generation controls reach the job', async (t) => {
  const replyVoice = new Float32Array(2400).fill(0.1)
  const { jobs, updates } = await runRecorded({
    audio: question(),
    sampleRate: QUESTION_RATE,
    replyVoice,
    replyVoiceSampleRate: NATIVE_RATE,
    textReply: true,
    maxReplySeconds: 5,
    maxNewTokens: 300,
    greedy: true,
    temperature: 0.5,
    topP: 0.9,
    topK: 10
  })
  t.is(jobs[0].replyVoice, replyVoice)
  t.is(jobs[0].replyVoiceSampleRate, NATIVE_RATE)
  t.is(jobs[0].textReply, true)
  t.is(jobs[0].maxReplySeconds, 5)
  t.is(jobs[0].maxNewTokens, 300)
  t.is(jobs[0].greedy, true)
  t.is(jobs[0].temperature, 0.5)
  t.is(jobs[0].topP, 0.9)
  t.is(jobs[0].topK, 10)
  t.is(updates[0].outputArray.length, 0, 'a text reply carries no audio')
  t.is(updates[0].text, REPLY_TEXT)
})

test('MOSS-Speech: malformed calls are rejected before queueing', async (t) => {
  const binding = new SpeechBinding()
  const model = createMockedSpeechModel({ binding })
  await model.load()
  const audio = question()
  const cases = [
    [{}, /needs the user turn as audio \(with sampleRate\) or input text/],
    [{ audio, sampleRate: QUESTION_RATE, input: 'both' }, /audio or input text, not both/],
    [{ audio }, /sampleRate must be an integer in \[8000, 192000\]/],
    [
      { audio: [1, 2, 3], sampleRate: QUESTION_RATE },
      /audio must be a non-empty Int16Array or Float32Array/
    ],
    [{ audio: new Int16Array(0), sampleRate: QUESTION_RATE }, /non-empty/],
    [{ audio, sampleRate: 4000 }, /sampleRate must be an integer/],
    [{ input: 'hi', messages: 'nope' }, /messages must be an array/],
    [{ input: 'hi', messages: [{ role: 'narrator', text: 'x' }] }, /role must be one of/],
    [{ input: 'hi', messages: [{ role: 'user' }] }, /exactly one of text or audio/],
    [
      { input: 'hi', messages: [{ role: 'user', text: 'x', audio, sampleRate: QUESTION_RATE }] },
      /exactly one/
    ],
    [{ input: 'hi', replyVoice: audio }, /replyVoiceSampleRate must be an integer/],
    [{ input: 'hi', maxReplySeconds: -1 }, /maxReplySeconds must be in \[0, 3600\]/],
    [{ input: 'hi', maxNewTokens: 5000 }, /maxNewTokens must be an integer in \[1, 4096\]/],
    [{ input: 'hi', temperature: 0 }, /temperature must be in \(0, 10\]/],
    [{ input: 'hi', topP: 1.5 }, /topP must be in \(0, 1\]/],
    [{ input: 'hi', topK: -1 }, /topK must be an integer >= 0/],
    [{ input: 'hi', greedy: 'yes' }, /greedy must be a boolean/],
    [{ input: 'hi', systemPrompt: 7 }, /systemPrompt must be a string/]
  ]
  await expectEachRejected(t, model, cases)
  t.is(binding.jobs.length, 0, 'no job queued')
  await model.unload()
})

test('MOSS-Speech: speech-only fields on another engine throw', async (t) => {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_MOSS,
    files: { mossBackbone: BACKBONE, mossCodecDecoder: DECODER }
  })
  model._createAddon = (params, cb) => new TTSInterface(new MockedBinding(), params, cb)
  await model.load()
  await t.exception(
    model.run({ type: 'text', input: 'x', audio: question(), sampleRate: QUESTION_RATE }),
    /moss-speech-only options/
  )
  await model.unload()
})

test('MOSS-Speech: there is no sentence streaming', async (t) => {
  const model = createMockedSpeechModel()
  await model.load()
  await t.exception(model.runStream('Hello there. How are you?'), /answers one turn at a time/)
  await t.exception(model.run({ input: 'Hello.', streamOutput: true }), /does not stream/)
  await t.exception(model.runStreaming(['Hello.']), /does not stream/)
  await model.unload()
})

test('MOSS-Speech: reload keeps both files and refuses a non-native output rate', async (t) => {
  const model = createMockedSpeechModel()
  await model.load()
  await model.reload({ useGPU: true })
  t.is(model._buildTtsParams().mossSpeechModelPath, SPEECH_MODEL)
  t.is(model._buildTtsParams().mossSpeechCodecPath, SPEECH_CODEC)
  t.is(model._buildTtsParams().useGPU, true)
  await t.exception(
    model.reload({ outputSampleRate: 16000 }),
    /moss-speech engine outputs 24000 Hz/
  )
  t.absent(model._buildTtsParams().outputSampleRate, 'the refused rate is rolled back')
  await model.unload()
})

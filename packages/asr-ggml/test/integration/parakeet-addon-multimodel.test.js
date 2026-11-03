'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const test = require('brittle')
const {
  binding,
  ASRGgml,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip
} = require('./parakeet-helpers.js')

const { samplesDir } = getTestPaths()
const NEMOTRON_SPEAKER_COUNT = 8

function loadAudioSample(filename = 'sample.raw') {
  const samplePath = path.join(samplesDir, filename)
  if (!fs.existsSync(samplePath)) return null
  const rawBuffer = fs.readFileSync(samplePath)
  const pcm = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2)
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / 32768.0
  return audio
}

async function transcribe(model, audio) {
  const segments = []
  const response = await model.run(audio)
  await response
    .onUpdate((out) => {
      const items = Array.isArray(out) ? out : [out]
      for (const seg of items) {
        if (seg && seg.text) segments.push(seg)
      }
    })
    .await()
  return segments
}

async function* singleAudioChunk(audio) {
  yield audio
}

async function collectStreamingSegments(model, audio) {
  const segments = []
  const response = await model.runStreaming(singleAudioChunk(audio))
  await response
    .onUpdate((out) => {
      const items = Array.isArray(out) ? out : [out]
      appendSpeakerUpdates(segments, items)
    })
    .await()
  return segments
}

function appendSpeakerUpdates(segments, updates) {
  for (const update of updates) {
    if (update && update.text && update.speakerId >= 0) segments.push(update)
  }
}

function checkStreamingSpeakerSegments(t, segments, pathName) {
  t.ok(segments.length > 0, `${pathName} returns speaker segments`)
  t.ok(
    segments.every(
      (segment) =>
        segment.speakerId < NEMOTRON_SPEAKER_COUNT &&
        segment.text.includes(`Speaker ${segment.speakerId}:`)
    ),
    `${pathName} preserves structured speaker IDs and labels`
  )
}

// The offline diarization transcript lists its turns in speakerSegments,
// one per "Speaker N: start - end" line of the text.
function checkSpeakerSegments(t, segments) {
  const lines = segments.flatMap((s) => s.text.split('\n')).filter((l) => l.includes('Speaker'))
  const turns = segments.flatMap((s) => s.speakerSegments || [])
  t.is(turns.length, lines.length, 'one speakerSegments entry per speaker line')
  t.ok(
    turns.every((turn, i) => {
      const m = lines[i].match(/Speaker\s+(\d+)/)
      return m && Number(m[1]) === turn.speakerId && turn.end >= turn.start
    }),
    'speakerSegments match the speaker ids and order of the text'
  )
}

async function runModelTest(t, modelType, modelPath, audio, expectations) {
  const parakeetConfig = Object.assign(
    { maxThreads: 4, useGPU: false },
    expectations.parakeetConfig || {}
  )
  const model = new ASRGgml({
    files: { model: modelPath },
    config: { engine: 'parakeet', parakeetConfig }
  })
  try {
    await model.load()
    t.is(
      model.getBackendInfo().modelType,
      expectations.backendModelType,
      `${modelType} reports modelType "${expectations.backendModelType}"`
    )
    const segments = await transcribe(model, audio)
    const joiner = modelType === 'sortformer' ? '\n' : ' '
    const fullText = segments
      .map((s) => s.text)
      .join(joiner)
      .trim()
    console.log(
      `[${modelType}] Result: "${fullText.substring(0, 120)}${fullText.length > 120 ? '...' : ''}"`
    )

    t.ok(segments.length > 0, `${modelType} produced ${segments.length} segments`)
    if (expectations.containsSpeaker) {
      t.ok(fullText.includes('Speaker'), `${modelType} output contains speaker labels`)
      checkSpeakerSegments(t, segments)
    } else {
      t.ok(
        fullText.length > expectations.minTextLength,
        `${modelType} produced text (${fullText.length} chars)`
      )
    }
    return segments
  } finally {
    try {
      await model.unload()
    } catch (e) {
      /* ignore */
    }
  }
}

test('CTC desktop integration — English transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'ctc')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }
    await runModelTest(t, 'ctc', modelPath, audio, {
      minTextLength: 10,
      backendModelType: 'ctc'
    })
  } finally {
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      /* ignore */
    }
  }
})

test('Unified desktop integration — English transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'unified')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }
    await runModelTest(t, 'unified', modelPath, audio, {
      minTextLength: 10,
      backendModelType: 'rnnt'
    })
  } finally {
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      /* ignore */
    }
  }
})

test(
  'Parakeet attributed transcription retains both models and supports standalone reload',
  { timeout: 600000 },
  async (t) => {
    const asrPath = await loadGgufOrSkip(t, 'unified')
    const diarizerPath = await loadGgufOrSkip(t, 'sortformer')
    if (!asrPath || !diarizerPath) return
    const audio = loadAudioSample()
    t.ok(audio, 'the staged audio fixture is available')
    if (!audio) return
    const model = new ASRGgml({
      files: { model: asrPath },
      config: {
        engine: 'parakeet',
        parakeetConfig: {
          backend: 'cpu',
          useGPU: true,
          speakerAttribution: {
            modelPath: diarizerPath,
            mergeSameSpeaker: false,
            minSegmentMs: 0,
            padSegmentMs: 80
          }
        }
      }
    })
    try {
      await model.load()
      t.is(
        model.getBackendInfo().backendDevice,
        'CPU',
        'explicit backend overrides the GPU preference'
      )
      const first = await transcribe(model, audio)
      t.ok(first.length > 0, 'the attributed API returns transcription text')
      t.ok(
        first.every(
          (segment) =>
            Number.isInteger(segment.speakerId) &&
            segment.speakerId >= 0 &&
            segment.isFinal === true &&
            segment.end >= segment.start
        ),
        'text carries the native speaker and turn times'
      )
      const second = await transcribe(model, audio)
      t.alike(second, first, 'repeated runs reuse both models with stable output')
      await model.reload({ parakeetConfig: { speakerAttribution: undefined } })
      const plain = await transcribe(model, audio)
      t.ok(plain.length > 0, 'standalone ASR works after removing attribution')
      t.ok(
        plain.every((segment) => segment.speakerId === undefined && segment.isFinal === undefined),
        'plain batch output retains its original shape'
      )
    } finally {
      await model.unload()
    }
  }
)

test(
  'Parakeet explicit unavailable backend rejects without automatic CPU retry',
  { timeout: 600000 },
  async (t) => {
    const modelPath = await loadGgufOrSkip(t, 'unified')
    if (!modelPath) return
    const model = new ASRGgml({
      files: { model: modelPath },
      config: {
        engine: 'parakeet',
        parakeetConfig: { backend: 'unavailable-test-device', useGPU: true }
      }
    })
    try {
      await t.exception(model.load(), 'unavailable explicit backend must reject')
    } finally {
      await model.unload()
    }
  }
)

test(
  'Parakeet attribution rejects missing and incompatible model pairs',
  { timeout: 600000 },
  async (t) => {
    const asrPath = await loadGgufOrSkip(t, 'unified')
    const diarizerPath = await loadGgufOrSkip(t, 'sortformer')
    if (!asrPath || !diarizerPath) return
    for (const [modelPath, speakerModelPath] of [
      [asrPath, asrPath],
      [diarizerPath, diarizerPath],
      [asrPath, asrPath + '.missing']
    ]) {
      const model = new ASRGgml({
        files: { model: modelPath },
        config: {
          engine: 'parakeet',
          parakeetConfig: { backend: 'cpu', speakerAttribution: { modelPath: speakerModelPath } }
        }
      })
      try {
        await t.exception(model.load(), 'both model families and files must be valid')
      } finally {
        await model.unload()
      }
    }
  }
)

test('EOU desktop integration — streaming transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'eou')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }
    await runModelTest(t, 'eou', modelPath, audio, {
      minTextLength: 0,
      backendModelType: 'eou'
    })
  } finally {
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      /* ignore */
    }
  }
})

test('Sortformer desktop integration — speaker diarization', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'sortformer')
    if (!modelPath) return
    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }
    await runModelTest(t, 'sortformer', modelPath, audio, {
      containsSpeaker: true,
      backendModelType: 'sortformer'
    })
  } finally {
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      /* ignore */
    }
  }
})

test(
  'Nemotron 3 desktop integration — eight-speaker diarization',
  { timeout: 600000 },
  async (t) => {
    const modelPath = process.env.QVAC_TEST_NEMOTRON_DIARIZATION_GGUF
    if (!modelPath || !fs.existsSync(modelPath)) {
      t.pass('Set QVAC_TEST_NEMOTRON_DIARIZATION_GGUF to run this model test')
      return
    }
    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }
    const loggerBinding = setupJsLogger(binding)
    try {
      const outputs = await runModelTest(t, 'nemotron-diarization', modelPath, audio, {
        containsSpeaker: true,
        backendModelType: 'nemotron-diarization'
      })
      const segments = outputs.flatMap((output) => output.speakerSegments || [])
      t.ok(segments.length > 0, 'Nemotron 3 returns structured speaker segments')
      t.ok(
        segments.every(
          (segment) => segment.speakerId >= 0 && segment.speakerId < NEMOTRON_SPEAKER_COUNT
        ),
        'speaker IDs stay within the eight-speaker range'
      )
    } finally {
      loggerBinding.releaseLogger()
    }
  }
)

test(
  'Nemotron 3 desktop integration — framework and duplex streaming diarization',
  { timeout: 600000 },
  async (t) => {
    const modelPath = process.env.QVAC_TEST_NEMOTRON_DIARIZATION_GGUF
    if (!modelPath || !fs.existsSync(modelPath)) {
      t.pass('Set QVAC_TEST_NEMOTRON_DIARIZATION_GGUF to run this model test')
      return
    }
    const audio = loadAudioSample()
    if (!audio) {
      t.pass('sample.raw not found — skipping')
      return
    }
    const model = new ASRGgml({
      files: { model: modelPath },
      config: {
        engine: 'parakeet',
        parakeetConfig: { streaming: true, maxThreads: 4, useGPU: false }
      }
    })
    const loggerBinding = setupJsLogger(binding)
    try {
      await model.load()
      t.is(model.getBackendInfo().modelType, 'nemotron-diarization')
      checkStreamingSpeakerSegments(t, await transcribe(model, audio), 'framework streaming')
      checkStreamingSpeakerSegments(
        t,
        await collectStreamingSegments(model, audio),
        'duplex streaming'
      )
    } finally {
      try {
        await model.unload()
      } finally {
        loggerBinding.releaseLogger()
      }
    }
  }
)

test(
  'Sortformer — diarizationMinSegmentMs longer than the clip drops every turn',
  { timeout: 600000 },
  async (t) => {
    const loggerBinding = setupJsLogger(binding)
    try {
      const modelPath = await loadGgufOrSkip(t, 'sortformer')
      if (!modelPath) return
      const audio = loadAudioSample()
      if (!audio) {
        t.pass('sample.raw not found — skipping')
        return
      }
      const model = new ASRGgml({
        files: { model: modelPath },
        config: {
          engine: 'parakeet',
          parakeetConfig: { maxThreads: 4, useGPU: false, diarizationMinSegmentMs: 600000 }
        }
      })
      try {
        await model.load()
        const segments = await transcribe(model, audio)
        t.is(segments.length, 1, 'one offline transcript')
        t.is(segments[0].text, '[No speakers detected]', 'every turn is shorter than the minimum')
        t.is(segments[0].speakerSegments, undefined, 'no speakerSegments without turns')
      } finally {
        try {
          await model.unload()
        } catch (e) {
          /* ignore */
        }
      }
    } finally {
      try {
        loggerBinding.releaseLogger()
      } catch (e) {
        /* ignore */
      }
    }
  }
)

test('Indic Conformer CTC — Hindi transcription', { timeout: 600000 }, async (t) => {
  const loggerBinding = setupJsLogger(binding)
  try {
    const modelPath = await loadGgufOrSkip(t, 'indicConformer')
    if (!modelPath) return
    const audio = loadAudioSample('sample_hi.raw')
    if (!audio) {
      t.pass('sample_hi.raw not found — skipping')
      return
    }
    await runModelTest(t, 'indicConformer', modelPath, audio, {
      minTextLength: 10,
      backendModelType: 'ctc',
      parakeetConfig: { language: 'hi' }
    })
  } finally {
    try {
      loggerBinding.releaseLogger()
    } catch (e) {
      /* ignore */
    }
  }
})

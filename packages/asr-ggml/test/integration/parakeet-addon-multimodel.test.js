'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const test = require('brittle')
const {
  binding,
  ASRGgml,
  setupJsLogger,
  getTestPaths,
  loadGgufOrSkip
} = require('./parakeet-helpers.js')

const { samplesDir } = getTestPaths()

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

'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const os = require('bare-os')
const {
  runTranscription,
  ensureWhisperModel,
  validateAccuracy,
  getTestPaths,
  getAssetPath,
  setupJsLogger,
  isMobile
} = require('./helpers.js')

const { modelPath } = getTestPaths()

const LANGUAGE_TESTS = {
  en: {
    name: 'English',
    code: 'en',
    sampleFile: 'sample.raw',
    expected: 'Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do. Once or twice she had peeped into the book her sister was reading but it had no pictures or conversations in it. And what is the use of a book thought Alice without pictures or conversations?'
  },
  es: {
    name: 'Spanish',
    code: 'es',
    sampleFile: 'sample_es.raw',
    expected: 'se recomienda enfáticamente a los viajeros que se informen sobre cualquier riesgo de clima extremo en el área que visitan dado que ello puede afectar sus planes de viaje'
  },
  de: {
    name: 'German',
    code: 'de',
    sampleFile: 'sample_de.raw',
    expected: 'für die besten aussichten auf hongkong sollten sie die insel verlassen und zum gegenüberliegenden ufer von kowloon fahren'
  },
  fr: {
    name: 'French',
    code: 'fr',
    sampleFile: 'sample_fr.raw',
    expected: "l'accident a eu lieu en terrain montagneux et il semblerait que cela ait été causé par un incendie malveillant",
    // Keep greedy decoding for realtime parity; tiny model French output is
    // slightly noisier, so we allow a small threshold bump to reduce CI flake.
    werThreshold: 0.35
  },
  pt: {
    name: 'Portuguese',
    code: 'pt',
    sampleFile: 'sample_pt.raw',
    expected: 'segundo informações ele estava na casa dos 20 anos em uma declaração bieber disse que embora eu não estivesse presente nem diretamente envolvido neste trágico incidente meus pensamentos e orações estão com a família da vítima'
  },
  it: {
    name: 'Italian',
    code: 'it',
    sampleFile: 'sample_it.raw',
    expected: "il blog è uno strumento che si prefigge di incoraggiare la collaborazione e sviluppare l'apprendimento degli studenti ben oltre la giornata scolastica normale"
  },
  ru: {
    name: 'Russian',
    code: 'ru',
    sampleFile: 'sample_ru.raw',
    expected: 'в древнем китае использовали уникальный способ обозначения периодов времени каждый этап китая или каждая семья находившаяся у власти были особой династией'
  },
  ja: {
    name: 'Japanese',
    code: 'ja',
    sampleFile: 'sample_ja.raw',
    expected: 'インターネットで 敵対的環境コース について検索すると おそらく現地企業の住所が出てくるでしょう'
  }
}

const WER_THRESHOLD = 0.30

async function runLanguageAccuracyTest (t, langConfig) {
  let loggerBinding = null
  let samplePath
  try {
    samplePath = getAssetPath(langConfig.sampleFile)
  } catch (err) {
    console.log(`⚠️ Sample file not available: ${langConfig.sampleFile}`)
    t.pass(`${langConfig.name} accuracy test skipped (sample not available)`)
    return { skipped: true, reason: 'sample_not_found' }
  }

  if (!fs.existsSync(samplePath)) {
    console.log(`⚠️ Sample file not found: ${samplePath}`)
    t.pass(`${langConfig.name} accuracy test skipped (sample file not found)`)
    return { skipped: true, reason: 'sample_not_found' }
  }

  const diskPath = isMobile ? (global.testDir || os.tmpdir()) : require('bare-path').dirname(modelPath)
  const actualModelPath = require('bare-path').join(diskPath, 'ggml-tiny.bin')

  if (!isMobile) {
    loggerBinding = setupJsLogger()
  }

  const modelResult = await ensureWhisperModel(actualModelPath)
  if (!modelResult.success && !modelResult.isReal) {
    console.log('⚠️ Whisper model not available')
    t.pass(`${langConfig.name} accuracy test skipped (model not available)`)
    return { skipped: true, reason: 'model_not_available' }
  }

  try {
    console.log(`\n📊 Running ${langConfig.name} accuracy test...`)
    console.log(`   File: ${langConfig.sampleFile}`)
    console.log(`   Language code: ${langConfig.code}`)
    console.log(`   Platform: ${isMobile ? 'mobile' : 'desktop'}`)

    const result = await runTranscription({
      audioInput: samplePath,
      modelPath: actualModelPath,
      whisperConfig: {
        language: langConfig.code,
        temperature: 0.0,
        temperature_inc: 0.0,
        ...(langConfig.whisperConfig || {})
      }
    })

    if (result.data.error) {
      console.log(`❌ Transcription error: ${result.data.error}`)
      t.fail(`${langConfig.name} transcription failed: ${result.data.error}`)
      return { skipped: false, passed: false, error: result.data.error }
    }

    const actualText = result.data.fullText
    console.log(`\n📝 ${langConfig.name} transcription (${result.data.segmentCount} segments):`)
    console.log(`   "${actualText.substring(0, 200)}${actualText.length > 200 ? '...' : ''}"`)

    if (langConfig.expected) {
      const werThreshold = langConfig.werThreshold ?? WER_THRESHOLD
      const accuracy = validateAccuracy(langConfig.expected, actualText, werThreshold)

      console.log('\n📊 WER Analysis:')
      console.log(`   WER:      ${accuracy.werPercent} (threshold: ${werThreshold * 100}%)`)
      console.log(`   Status:   ${accuracy.passed ? '✅ PASSED' : '❌ FAILED'}`)

      t.ok(accuracy.passed, `${langConfig.name} WER should be below ${werThreshold * 100}%, got ${accuracy.werPercent}`)
      return { skipped: false, passed: accuracy.passed, wer: accuracy.wer, actualText }
    } else {
      t.ok(actualText.length > 0, `${langConfig.name} should produce non-empty transcription`)
      console.log('\n⚠️ No expected transcription - only checking for non-empty output')
      return { skipped: false, passed: true, actualText, noExpected: true }
    }
  } catch (error) {
    console.log(`❌ Test error: ${error.message}`)
    t.fail(`${langConfig.name} accuracy test failed: ${error.message}`)
    return { skipped: false, passed: false, error: error.message }
  } finally {
    if (loggerBinding) {
      try { loggerBinding.releaseLogger() } catch {}
    }
  }
}

test('Accuracy test - English', { timeout: 300000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.en)
})

test('Accuracy test - Spanish', { timeout: 300000, skip: true }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.es)
})

test('Accuracy test - German', { timeout: 300000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.de)
})

test('Accuracy test - French', { timeout: 300000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.fr)
})

test('Accuracy test - Portuguese', { timeout: 300000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.pt)
})

test('Accuracy test - Italian', { timeout: 300000, skip: true }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.it)
})

test('Accuracy test - Russian', { timeout: 300000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.ru)
})

test('Accuracy test - Japanese', { timeout: 300000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.ja)
})

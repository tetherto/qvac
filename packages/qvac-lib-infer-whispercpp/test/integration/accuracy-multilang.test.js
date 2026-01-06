'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const {
  runTranscription,
  ensureWhisperModel,
  validateAccuracy,
  getTestPaths,
  setupJsLogger
} = require('./helpers.js')

const { modelPath, samplesDir } = getTestPaths()

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
    expected: "l'accident a eu lieu en terrain montagneux et il semblerait que cela ait été causé par un incendie malveillant"
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

const WER_THRESHOLD = 0.30 // 30%

async function runLanguageAccuracyTest (t, langConfig) {
  const loggerBinding = setupJsLogger()
  const samplePath = path.join(samplesDir, langConfig.sampleFile)

  // Check if sample file exists
  if (!fs.existsSync(samplePath)) {
    console.log(`⚠️ Sample file not found: ${langConfig.sampleFile}`)
    t.pass(`${langConfig.name} accuracy test skipped (sample file not found)`)
    return { skipped: true, reason: 'sample_not_found' }
  }

  // Check if expected transcription is defined
  if (!langConfig.expected) {
    console.log(`⚠️ No expected transcription defined for ${langConfig.name}`)
  }

  const whisperResult = await ensureWhisperModel(modelPath)
  if (!whisperResult.isReal) {
    console.log('⚠️ Real whisper model not available')
    t.pass(`${langConfig.name} accuracy test skipped (model not available)`)
    return { skipped: true, reason: 'model_not_available' }
  }

  try {
    console.log(`\n📊 Running ${langConfig.name} accuracy test...`)
    console.log(`   File: ${langConfig.sampleFile}`)
    console.log(`   Language code: ${langConfig.code}`)

    const result = await runTranscription({
      audioInput: samplePath,
      modelPath,
      whisperConfig: {
        language: langConfig.code,
        temperature: 0.0
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

    // Validate WER if expected transcription is defined
    if (langConfig.expected) {
      const accuracy = validateAccuracy(langConfig.expected, actualText, WER_THRESHOLD)

      console.log('\n📊 WER Analysis:')
      console.log(`   WER:      ${accuracy.werPercent} (threshold: 30%)`)
      console.log(`   Status:   ${accuracy.passed ? '✅ PASSED' : '❌ FAILED'}`)

      t.ok(accuracy.passed, `${langConfig.name} WER should be below 30%, got ${accuracy.werPercent}`)
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
    try { loggerBinding.releaseLogger() } catch {}
  }
}

test('Accuracy test - English', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.en)
})

test('Accuracy test - Spanish', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.es)
})

test('Accuracy test - German', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.de)
})

test('Accuracy test - French', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.fr)
})

test('Accuracy test - Portuguese', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.pt)
})

test('Accuracy test - Italian', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.it)
})

test('Accuracy test - Russian', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.ru)
})

test('Accuracy test - Japanese', { timeout: 120000 }, async (t) => {
  await runLanguageAccuracyTest(t, LANGUAGE_TESTS.ja)
})

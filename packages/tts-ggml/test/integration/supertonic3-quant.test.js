'use strict'

// Supertonic 3 integration: exercises the published fp16 / fp32 GGUFs plus the
// q8_0 / q4_0 block-quant tiers across the five Supertonic 2 languages
// (en/ko/es/pt/fr) and a few of the new v3-only languages (de/it/nl).  This is
// the coverage that guards the v3 work in tts-cpp:
//   - fp16 / fp32 must load + run across the inherited + new languages,
//   - q4_0 must load + run (it used to SIGBUS before Q4_0 dequant-at-load),
//   - the ConvNeXt pointwise convs squeezed by the requantizer must re-expand
//     correctly via supertonic.pwconv_squeezed,
//   - the v3 language-conditioning path must accept both the inherited and the
//     new language codes.
//
// All four tiers are pulled from the QVAC model registry (S3): fp16 / fp32 from
// the 2026-06-10 build (QVAC-20568) and the q8_0 / q4_0 block-quants from the
// 2026-06-15 build (QVAC-20686).  Every tier is published, so a fetch failure
// is a real error and the corresponding test FAILS (it no longer self-skips).
// CI stages all four tiers via `download-models:registry`.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { runSupertonicTTS } = require('../utils/runSupertonicTTS')
const { ensureSupertonic3Model } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const SAMPLE_RATE = 44100

// Tiers to sweep.  All four are fetched from the registry (fp16/fp32 @
// 2026-06-10, q8_0/q4_0 @ 2026-06-15); a tier that can't be fetched fails.
const QUANTS = ['f16', 'f32', 'q8_0', 'q4_0']

// Existing (inherited from Supertonic 2) + new v3-only languages.  The new
// ones are deliberately Latin-script so the test sentences don't need
// language-specific tokenizer fixtures.
const SENTENCES = [
  // --- existing Supertonic 2 languages ---
  { lang: 'en', text: 'The quick brown fox jumps over the lazy dog.', group: 'existing' },
  { lang: 'ko', text: '다람쥐 헌 쳇바퀴에 타고파.', group: 'existing' },
  { lang: 'es', text: 'El zorro marrón salta sobre el perro perezoso.', group: 'existing' },
  { lang: 'pt', text: 'A raposa marrom pula sobre o cachorro preguiçoso.', group: 'existing' },
  { lang: 'fr', text: 'Le renard brun saute par-dessus le chien paresseux.', group: 'existing' },
  // --- new Supertonic 3 languages ---
  { lang: 'de', text: 'Der schnelle braune Fuchs springt über den faulen Hund.', group: 'new' },
  { lang: 'it', text: 'La rapida volpe marrone salta sopra il cane pigro.', group: 'new' },
  { lang: 'nl', text: 'De snelle bruine vos springt over de luie hond.', group: 'new' }
]

async function loadSupertonic3TTS (params) {
  const model = new TTSGgml({
    engine: TTSGgml.ENGINE_SUPERTONIC,
    files: { supertonicModel: params.supertonicModelPath },
    voice: params.voice || 'F1',
    config: { language: params.language || 'en', useGPU: false },
    opts: { stats: true }
  })
  await model.load()
  return model
}

for (const quant of QUANTS) {
  test(`Supertonic 3 (${quant}): synthesizes across existing + new languages`, { timeout: 1800000 }, async (t) => {
    const baseDir = getBaseDir()
    const download = await ensureSupertonic3Model({
      targetDir: path.join(baseDir, 'models'),
      quant
    })
    if (!download.success) {
      t.fail(`supertonic3-${quant}.gguf could not be fetched from the registry. ` +
        'All four tiers are published on the QVAC registry (S3); a fetch ' +
        'failure is a real error (network / registry unavailable, or the ' +
        '@qvac/registry-client devDependency is missing).')
      return
    }

    const model = await loadSupertonic3TTS({
      supertonicModelPath: download.path,
      language: SENTENCES[0].lang
    })
    try {
      for (let i = 0; i < SENTENCES.length; i++) {
        const { lang, text, group } = SENTENCES[i]
        console.log(`  [${quant}/${group}/${lang}] "${text.slice(0, 50)}..."`)
        if (i > 0) {
          await model.reload({ language: lang })
        }
        const result = await runSupertonicTTS(
          model,
          { text },
          { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 }
        )
        console.log('    ' + result.output)

        t.ok(result.passed, `Supertonic 3 ${quant} ${lang} (${group}) run passes expectations`)
        t.ok(result.data.sampleCount > 0, `Supertonic 3 ${quant} ${lang} (${group}) produced audio`)
        t.is(result.data.reportedSampleRate || SAMPLE_RATE, SAMPLE_RATE,
          `Supertonic 3 ${quant} ${lang} reports 44.1 kHz`)
      }
    } finally {
      try { await model.unload() } catch (_e) {}
    }
  })
}

import test from 'brittle'
import {
  TTS_ENGINES,
  TTS_PACES,
  TTS_PARLER_EMOTIONS,
  TTS_SENTENCE_DELIMITER_PRESETS,
  TTS_CHATTERBOX_LANGUAGES,
  TTS_SUPERTONIC_LANGUAGES,
  TTS_COSYVOICE3_EMOTIONS,
  TTS_COSYVOICE3_INSTRUCT_DIALECTS,
  TTS_COSYVOICE3_INSTRUCT_VOLUMES,
  TTS_COSYVOICE3_INSTRUCT_STYLES
} from '@/index'
import * as ttsSchemas from '@qvac/inference/surface'
import { constantsRegistry } from '../scripts/contract/constants-registry'

// Root-import contract: the vocabulary constants documented as public API must
// be reachable from the package root, not just the internal schemas module.
test('TTS vocabulary constants are exported from the package root', (t) => {
  t.is(TTS_PACES, ttsSchemas.TTS_PACES)
  t.is(TTS_COSYVOICE3_EMOTIONS, ttsSchemas.TTS_COSYVOICE3_EMOTIONS)
  t.is(TTS_COSYVOICE3_INSTRUCT_DIALECTS, ttsSchemas.TTS_COSYVOICE3_INSTRUCT_DIALECTS)
  t.is(TTS_COSYVOICE3_INSTRUCT_VOLUMES, ttsSchemas.TTS_COSYVOICE3_INSTRUCT_VOLUMES)
  t.is(TTS_COSYVOICE3_INSTRUCT_STYLES, ttsSchemas.TTS_COSYVOICE3_INSTRUCT_STYLES)

  t.alike([...TTS_PACES], ['slow', 'moderate', 'fast'])
  t.alike([...TTS_COSYVOICE3_EMOTIONS], ['anger', 'happy', 'neutral', 'sad'])
  t.is(TTS_COSYVOICE3_INSTRUCT_DIALECTS.length, 17)
  t.alike([...TTS_COSYVOICE3_INSTRUCT_VOLUMES], ['loud', 'soft'])
  t.alike([...TTS_COSYVOICE3_INSTRUCT_STYLES], ['peppa', 'robot'])
})

// The vocabularies added with the @qvac/tts-ggml parity work: the engine
// list, Parler's emotion set, the stream delimiter presets, and the
// per-engine language lists that a caller must pick `language` from.
test('engine, Parler and language vocabularies are exported from the package root', (t) => {
  t.is(TTS_ENGINES, ttsSchemas.TTS_ENGINES)
  t.is(TTS_PARLER_EMOTIONS, ttsSchemas.TTS_PARLER_EMOTIONS)
  t.is(TTS_SENTENCE_DELIMITER_PRESETS, ttsSchemas.TTS_SENTENCE_DELIMITER_PRESETS)
  t.is(TTS_CHATTERBOX_LANGUAGES, ttsSchemas.TTS_CHATTERBOX_LANGUAGES)
  t.is(TTS_SUPERTONIC_LANGUAGES, ttsSchemas.TTS_SUPERTONIC_LANGUAGES)

  t.alike([...TTS_ENGINES], ['chatterbox', 'supertonic', 'parler', 'cosyvoice3', 'audio8'])
  t.is(TTS_PARLER_EMOTIONS.length, 12)
  t.alike([...TTS_SENTENCE_DELIMITER_PRESETS], ['latin', 'cjk', 'multilingual'])
  t.is(TTS_CHATTERBOX_LANGUAGES.length, 23)
  t.is(TTS_SUPERTONIC_LANGUAGES.length, 31)
})

// Cross-language contract: the same vocabularies must reach non-JS clients via
// the constants registry (merged into schema.json as constants.* $defs).
test('TTS vocabulary constants are registered for cross-language codegen', (t) => {
  t.alike(Object.values(constantsRegistry.TtsPace.enum), [...TTS_PACES])
  t.alike(Object.values(constantsRegistry.TtsCosyvoice3Emotion.enum), [...TTS_COSYVOICE3_EMOTIONS])
  t.alike(Object.values(constantsRegistry.TtsCosyvoice3InstructDialect.enum), [
    ...TTS_COSYVOICE3_INSTRUCT_DIALECTS
  ])
  t.alike(Object.values(constantsRegistry.TtsCosyvoice3InstructVolume.enum), [
    ...TTS_COSYVOICE3_INSTRUCT_VOLUMES
  ])
  t.alike(Object.values(constantsRegistry.TtsCosyvoice3InstructStyle.enum), [
    ...TTS_COSYVOICE3_INSTRUCT_STYLES
  ])
  t.alike(Object.values(constantsRegistry.TtsEngine.enum), [...TTS_ENGINES])
  t.alike(Object.values(constantsRegistry.TtsParlerEmotion.enum), [...TTS_PARLER_EMOTIONS])
  t.alike(Object.values(constantsRegistry.TtsSentenceDelimiterPreset.enum), [
    ...TTS_SENTENCE_DELIMITER_PRESETS
  ])
  t.alike(Object.values(constantsRegistry.TtsChatterboxLanguage.enum), [
    ...TTS_CHATTERBOX_LANGUAGES
  ])
  t.alike(Object.values(constantsRegistry.TtsSupertonicLanguage.enum), [
    ...TTS_SUPERTONIC_LANGUAGES
  ])
  // 'proper noun' must survive as an identifier-safe varname for codegen.
  t.is(constantsRegistry.TtsParlerEmotion.enum['PROPER_NOUN'], 'proper noun')
})

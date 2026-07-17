import test from 'brittle'
import {
  TTS_PACES,
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
})

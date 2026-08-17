import test from 'brittle'
import {
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_MAX_SECONDS,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  AUDIOGEN_TASK_TYPES
} from '@/index'
import * as audioGenSchemas from '@/schemas/audio-gen'
import { constantsRegistry } from '@/schemas/constants-registry'

// Root-import contract: the vocabulary and PCM-layout constants documented as
// public API must be reachable from the package root, not just the internal
// schemas module.
test('AudioGen constants are exported from the package root', (t) => {
  t.is(AUDIOGEN_TASK_TYPES, audioGenSchemas.AUDIOGEN_TASK_TYPES)
  t.is(AUDIOGEN_INPUT_SAMPLE_RATE, audioGenSchemas.AUDIOGEN_INPUT_SAMPLE_RATE)
  t.is(AUDIOGEN_INPUT_CHANNELS, audioGenSchemas.AUDIOGEN_INPUT_CHANNELS)
  t.is(AUDIOGEN_INPUT_MAX_SECONDS, audioGenSchemas.AUDIOGEN_INPUT_MAX_SECONDS)

  t.alike([...AUDIOGEN_TASK_TYPES], ['text2music', 'cover-nofsq'])
  t.is(AUDIOGEN_INPUT_SAMPLE_RATE, 48000)
  t.is(AUDIOGEN_INPUT_CHANNELS, 2)
  t.is(AUDIOGEN_INPUT_MAX_SECONDS, 600)
})

// Cross-language contract: the task-type vocabulary must reach non-JS clients
// via the constants registry (merged into schema.json as constants.* $defs),
// with identifier-safe varnames.
test('AudioGen task types are registered for cross-language codegen', (t) => {
  t.alike(Object.values(constantsRegistry.AudioGenTaskType.enum), [...AUDIOGEN_TASK_TYPES])
  t.alike(Object.keys(constantsRegistry.AudioGenTaskType.enum), ['TEXT2MUSIC', 'COVER_NOFSQ'])
})

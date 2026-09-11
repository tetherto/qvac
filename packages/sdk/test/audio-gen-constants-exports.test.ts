import test from 'brittle'
import {
  AUDIOGEN_EDIT_OPERATIONS,
  AUDIOGEN_ENGINES,
  AUDIOGEN_INPUT_CHANNELS,
  AUDIOGEN_INPUT_MAX_SECONDS,
  AUDIOGEN_INPUT_SAMPLE_RATE,
  AUDIOGEN_MAX_AUDIO_CODES,
  AUDIOGEN_REPAINT_MODES,
  AUDIOGEN_TASK_TYPES
} from '@/index'
import * as audioGenSchemas from '@qvac/inference/surface'
import { constantsRegistry } from '../scripts/contract/constants-registry'

// Root-import contract: the vocabulary and PCM-layout constants documented as
// public API must be reachable from the package root, not just the internal
// schemas module.
test('AudioGen constants are exported from the package root', (t) => {
  t.is(AUDIOGEN_ENGINES, audioGenSchemas.AUDIOGEN_ENGINES)
  t.is(AUDIOGEN_TASK_TYPES, audioGenSchemas.AUDIOGEN_TASK_TYPES)
  t.is(AUDIOGEN_EDIT_OPERATIONS, audioGenSchemas.AUDIOGEN_EDIT_OPERATIONS)
  t.is(AUDIOGEN_REPAINT_MODES, audioGenSchemas.AUDIOGEN_REPAINT_MODES)
  t.is(AUDIOGEN_INPUT_SAMPLE_RATE, audioGenSchemas.AUDIOGEN_INPUT_SAMPLE_RATE)
  t.is(AUDIOGEN_INPUT_CHANNELS, audioGenSchemas.AUDIOGEN_INPUT_CHANNELS)
  t.is(AUDIOGEN_INPUT_MAX_SECONDS, audioGenSchemas.AUDIOGEN_INPUT_MAX_SECONDS)
  t.is(AUDIOGEN_MAX_AUDIO_CODES, audioGenSchemas.AUDIOGEN_MAX_AUDIO_CODES)

  t.alike([...AUDIOGEN_TASK_TYPES], ['text2music', 'cover-nofsq'])
  t.alike([...AUDIOGEN_EDIT_OPERATIONS], ['flow-edit', 'repaint'])
  t.alike([...AUDIOGEN_REPAINT_MODES], ['conservative', 'balanced', 'aggressive'])
  t.is(AUDIOGEN_INPUT_SAMPLE_RATE, 48000)
  t.is(AUDIOGEN_INPUT_CHANNELS, 2)
  t.is(AUDIOGEN_INPUT_MAX_SECONDS, 600)
  t.is(AUDIOGEN_MAX_AUDIO_CODES, 3000)
})

// Cross-language contract: the task-type vocabulary must reach non-JS clients
// via the constants registry (merged into schema.json as constants.* $defs),
// with identifier-safe varnames.
test('AudioGen task types are registered for cross-language codegen', (t) => {
  t.alike(Object.values(constantsRegistry.AudioGenEngine.enum), [...AUDIOGEN_ENGINES])
  t.alike(Object.keys(constantsRegistry.AudioGenEngine.enum), ['ACESTEP', 'MINIMAX'])
  t.alike(Object.values(constantsRegistry.AudioGenTaskType.enum), [...AUDIOGEN_TASK_TYPES])
  t.alike(Object.keys(constantsRegistry.AudioGenTaskType.enum), ['TEXT2MUSIC', 'COVER_NOFSQ'])
  t.alike(Object.values(constantsRegistry.AudioGenEditOperation.enum), [
    ...AUDIOGEN_EDIT_OPERATIONS
  ])
  t.alike(Object.keys(constantsRegistry.AudioGenEditOperation.enum), ['FLOW_EDIT', 'REPAINT'])
  t.alike(Object.values(constantsRegistry.AudioGenRepaintMode.enum), [...AUDIOGEN_REPAINT_MODES])
  t.alike(Object.keys(constantsRegistry.AudioGenRepaintMode.enum), [
    'CONSERVATIVE',
    'BALANCED',
    'AGGRESSIVE'
  ])
})

import test from 'brittle'
import {
  PARAKEET_0_6B_F16,
  PARAKEET_0_6B_Q4_0,
  PARAKEET_0_6B_Q8_0,
  PARAKEET_NEMOTRON_0_6B_F16,
  PARAKEET_NEMOTRON_0_6B_Q4_0,
  PARAKEET_NEMOTRON_0_6B_Q8_0,
  getModelByName
} from '@/models/registry'

const aliases = [
  ['PARAKEET_0_6B_F16', PARAKEET_0_6B_F16, PARAKEET_NEMOTRON_0_6B_F16],
  ['PARAKEET_0_6B_Q4_0', PARAKEET_0_6B_Q4_0, PARAKEET_NEMOTRON_0_6B_Q4_0],
  ['PARAKEET_0_6B_Q8_0', PARAKEET_0_6B_Q8_0, PARAKEET_NEMOTRON_0_6B_Q8_0]
] as const

test('published Parakeet model names remain compatibility aliases', (t) => {
  for (const [legacyName, legacy, canonical] of aliases) {
    t.is(legacy.name, legacyName, `${legacyName}: keeps its published export name`)
    t.is(legacy.src, canonical.src, `${legacyName}: resolves to the renamed Nemotron model`)
    t.is(legacy.sha256Checksum, canonical.sha256Checksum, `${legacyName}: keeps model identity`)
    t.is(getModelByName(legacyName), legacy, `${legacyName}: remains available by name`)
  }
})

import type { TestDefinition } from '@qvac/test-suite'

type ParakeetDependency =
  | 'parakeet-tdt'
  | 'parakeet-ctc'
  | 'parakeet-sortformer'
  | 'parakeet-indic-conformer'
  | 'parakeet-unified'

const createParakeetTest = (
  testId: string,
  dependency: ParakeetDependency,
  audioFileName: string,
  expectation:
    | { validation: 'contains-all' | 'contains-any'; contains: string[] }
    | { validation: 'regex'; pattern: string }
    | { validation: 'type'; expectedType: 'string' | 'number' | 'array' }
    | { validation: 'throws-error'; errorContains: string },
  estimatedDurationMs: number = 60000,
  suites?: string[]
): TestDefinition => ({
  testId,
  params: { audioFileName },
  expectation,
  ...(suites && { suites }),
  metadata: {
    category: 'parakeet',
    dependency,
    estimatedDurationMs
  }
})

// ── TDT INT8 tests ────────────────────────────────────────────────────────────
// Parakeet TDT 0.6B INT8 — multilingual speech-to-text

export const parakeetTdtWav = createParakeetTest(
  'parakeet-tdt-wav',
  'parakeet-tdt',
  'transcription-short-wav.wav',
  { validation: 'contains-all', contains: ['test', 'automation'] },
  300000, // download ~700 MB
  ['smoke']
)

export const parakeetTdtMp3 = createParakeetTest(
  'parakeet-tdt-mp3',
  'parakeet-tdt',
  'transcription-short-mp3.mp3',
  { validation: 'contains-all', contains: ['test', 'automation'] },
  120000
)

export const parakeetTdtM4a = createParakeetTest(
  'parakeet-tdt-m4a',
  'parakeet-tdt',
  'transcription-short-m4a.m4a',
  { validation: 'contains-all', contains: ['test'] },
  120000
)

export const parakeetTdtSilence = createParakeetTest(
  'parakeet-tdt-silence',
  'parakeet-tdt',
  'silence.m4a',
  { validation: 'type', expectedType: 'string' },
  120000
)

// Multi-segment: audio longer than a single processing chunk
export const parakeetTdtMultiSegment = createParakeetTest(
  'parakeet-tdt-multi-segment',
  'parakeet-tdt',
  'diarization-sample-16k.wav',
  { validation: 'type', expectedType: 'string' },
  180000
)

// Invalid MP3 — FFmpeg fails to decode it
export const parakeetTdtMusic = createParakeetTest(
  'parakeet-tdt-music',
  'parakeet-tdt',
  'only-music.mp3',
  { validation: 'throws-error', errorContains: 'Invalid data' },
  60000
)

// Corrupted WAV — decoder throws a codec-level error
export const parakeetTdtCorruptedWav = createParakeetTest(
  'parakeet-tdt-corrupted-wav',
  'parakeet-tdt',
  'corrupted-wav.wav',
  { validation: 'throws-error', errorContains: '' },
  60000,
  ['smoke']
)

// ── CTC tests ─────────────────────────────────────────────────────────────────
// Parakeet CTC FP32 — faster inference, no punctuation/capitalisation

export const parakeetCtcWav = createParakeetTest(
  'parakeet-ctc-wav',
  'parakeet-ctc',
  'transcription-short-wav.wav',
  { validation: 'type', expectedType: 'string' },
  600000 // CTC model download
)

export const parakeetCtcMp3 = createParakeetTest(
  'parakeet-ctc-mp3',
  'parakeet-ctc',
  'transcription-short-mp3.mp3',
  { validation: 'contains-all', contains: ['test', 'automation'] },
  200000,
  ['smoke']
)

export const parakeetCtcSilence = createParakeetTest(
  'parakeet-ctc-silence',
  'parakeet-ctc',
  'silence.m4a',
  { validation: 'type', expectedType: 'string' },
  120000
)

// Corrupted WAV on CTC path
export const parakeetCtcCorruptedWav = createParakeetTest(
  'parakeet-ctc-corrupted-wav',
  'parakeet-ctc',
  'corrupted-wav.wav',
  { validation: 'throws-error', errorContains: '' },
  60000
)

// ── Unified RNN-T tests ───────────────────────────────────────────────────────
// Parakeet Unified 0.6B — English batch + low-latency streaming from one
// checkpoint (standard RNN-T with punctuation and capitalization). The engine
// auto-detects the model type from the GGUF metadata.

export const parakeetUnifiedWav = createParakeetTest(
  'parakeet-unified-wav',
  'parakeet-unified',
  'transcription-short-wav.wav',
  { validation: 'contains-all', contains: ['test', 'automation'] },
  300000, // download ~400 MB (q4_0)
  ['smoke']
)

export const parakeetUnifiedMp3 = createParakeetTest(
  'parakeet-unified-mp3',
  'parakeet-unified',
  'transcription-short-mp3.mp3',
  { validation: 'contains-all', contains: ['test', 'automation'] },
  120000
)

export const parakeetUnifiedSilence = createParakeetTest(
  'parakeet-unified-silence',
  'parakeet-unified',
  'silence.m4a',
  { validation: 'type', expectedType: 'string' },
  120000
)

// Corrupted WAV on the Unified path
export const parakeetUnifiedCorruptedWav = createParakeetTest(
  'parakeet-unified-corrupted-wav',
  'parakeet-unified',
  'corrupted-wav.wav',
  { validation: 'throws-error', errorContains: '' },
  60000
)

// ── Indic Conformer CTC (desktop-only) ────────────────────────────────────────
// Multilingual CTC with a required `modelConfig.language` mask. Happy path
// uses the asr-ggml Hindi sample (`sample_hi.raw` wrapped as WAV) and asserts
// Devanagari rather than a brittle token list. Not tagged smoke: mobile is
// skipped, and smoke must be stable on both desktop and mobile.

export const parakeetIndicConformerHi = createParakeetTest(
  'parakeet-indic-conformer-hi',
  'parakeet-indic-conformer',
  'sample-hi.wav',
  { validation: 'regex', pattern: '[\\u0900-\\u097F]' },
  600000
)

export const parakeetIndicConformerSilence = createParakeetTest(
  'parakeet-indic-conformer-silence',
  'parakeet-indic-conformer',
  'silence.m4a',
  { validation: 'type', expectedType: 'string' },
  120000
)

export const parakeetIndicConformerCorruptedWav = createParakeetTest(
  'parakeet-indic-conformer-corrupted-wav',
  'parakeet-indic-conformer',
  'corrupted-wav.wav',
  { validation: 'throws-error', errorContains: '' },
  60000
)

// ── Sortformer v2.1 (diarization) tests ───────────────────────────────────────
// Batch `transcribe` on PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0 — expect "Speaker …"

export const parakeetSortformerSingle = createParakeetTest(
  'parakeet-sortformer-single',
  'parakeet-sortformer',
  'diarization-sample-16k.wav',
  { validation: 'contains-any', contains: ['Speaker'] },
  600000, // Sortformer model download
  ['smoke']
)

export const parakeetSortformerTwoSpeakers = createParakeetTest(
  'parakeet-sortformer-two-speakers',
  'parakeet-sortformer',
  'two-speakers-16k.wav',
  { validation: 'contains-any', contains: ['Speaker'] },
  180000
)

export const parakeetMetadataRejected: TestDefinition = {
  testId: 'parakeet-tdt-metadata-rejected',
  params: { audioFileName: 'transcription-short-wav.wav', metadata: true },
  expectation: {
    validation: 'throws-error',
    errorContains: 'does not support metadata'
  },
  metadata: { category: 'parakeet', dependency: 'parakeet-tdt', estimatedDurationMs: 30000 }
}

export const parakeetTdtTests = [
  parakeetTdtWav,
  parakeetTdtMp3,
  parakeetTdtM4a,
  parakeetTdtSilence,
  parakeetTdtMultiSegment,
  parakeetTdtMusic,
  parakeetTdtCorruptedWav,
  parakeetMetadataRejected
]

export const parakeetCtcTests = [
  parakeetCtcWav,
  parakeetCtcMp3,
  parakeetCtcSilence,
  parakeetCtcCorruptedWav
]

export const parakeetUnifiedTests = [
  parakeetUnifiedWav,
  parakeetUnifiedMp3,
  parakeetUnifiedSilence,
  parakeetUnifiedCorruptedWav
]

export const parakeetIndicConformerTests = [
  parakeetIndicConformerHi,
  parakeetIndicConformerSilence,
  parakeetIndicConformerCorruptedWav
]

export const parakeetSortformerTests = [parakeetSortformerSingle, parakeetSortformerTwoSpeakers]

export const parakeetTests = [
  ...parakeetTdtTests,
  ...parakeetCtcTests,
  ...parakeetUnifiedTests,
  ...parakeetIndicConformerTests,
  ...parakeetSortformerTests
]

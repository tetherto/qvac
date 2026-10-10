import test from 'brittle'
import { modelFitCandidateSchema, transcriptionFitWorkloadSchema } from '@/schemas/assess-model-fit'

test('MOSS fit workload shares transcription constraints and requires a positive duration', (t) => {
  t.alike(
    transcriptionFitWorkloadSchema.parse({ audioSeconds: 30, hotwords: [], maxNewTokens: 0 }),
    { audioSeconds: 30, hotwords: [], maxNewTokens: 0 }
  )
  for (const workload of [
    {},
    { audioSeconds: 0 },
    { audioSeconds: -1 },
    { audioSeconds: Infinity },
    { audioSeconds: 30, hotwords: [''] },
    { audioSeconds: 30, hotwords: ['é'.repeat(33)] },
    { audioSeconds: 30, maxNewTokens: -1 },
    { audioSeconds: 30, prompt: 'Transcribe', hotwords: ['Erin'] }
  ]) {
    t.exception(() => transcriptionFitWorkloadSchema.parse(workload))
  }
  t.is(
    modelFitCandidateSchema.parse({
      modelType: 'moss-transcribe',
      transcriptionWorkload: { audioSeconds: 30 }
    }).transcriptionWorkload?.audioSeconds,
    30
  )
})

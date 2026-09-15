import type { CompletionStats, LoadModelOptions } from '@qvac/sdk'
import type { LlamacppCompletionConfig } from '@/schemas/public'

const modelConfig: LlamacppCompletionConfig = {
  'spec-type': 'draft-mtp',
  'spec-draft-n-max': 3,
  'spec-draft-n-min': 0,
  'spec-draft-p-min': 0.5,
  'spec-draft-backend-sampling': false,
  'spec-draft-device': 'CPU',
  'spec-draft-ngl': 0
}

const loadOptions: LoadModelOptions = {
  modelType: 'llm',
  modelSrc: '/models/model-with-mtp.gguf',
  modelConfig
}
void loadOptions

const unsupportedDecoder: LlamacppCompletionConfig = {
  // @ts-expect-error Only MTP self-speculation is supported.
  'spec-type': 'draft'
}
void unsupportedDecoder

const stats: CompletionStats = { draftAccepted: 2, draftTotal: 3 }
const accepted: number | undefined = stats.draftAccepted
const total: number | undefined = stats.draftTotal
void accepted
void total

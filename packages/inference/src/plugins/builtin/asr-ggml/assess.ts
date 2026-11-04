import { assessFit, type AsrFitRequest } from '@qvac/asr-ggml'

import { normalizeAsrFitResult } from '@/plugins/builtin/asr-ggml/fit'

export async function assessAsrFit(request: AsrFitRequest) {
  return normalizeAsrFitResult(await assessFit(request))
}

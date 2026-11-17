import test from 'brittle'

import { nmtFitRequest } from '@/plugins/builtin/nmtcpp-translation/fit'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

function requestOf(plan: FitRequestPlan): Record<string, unknown> | undefined {
  return 'request' in plan ? (plan.request as Record<string, unknown>) : undefined
}

test('carries the files and config the load reads', (t) => {
  const load: FitLoad = {
    modelPath: '/models/enfr.intgemm.bin',
    modelConfig: { engine: 'Bergamot', from: 'en', to: 'fr' },
    artifacts: {
      srcVocabPath: '/models/vocab.enfr.spm',
      dstVocabPath: '/models/vocab.enfr.spm'
    },
    isShardedModel: false
  }

  const request = requestOf(nmtFitRequest(load))
  t.alike(request?.['files'], {
    model: '/models/enfr.intgemm.bin',
    srcVocab: '/models/vocab.enfr.spm',
    dstVocab: '/models/vocab.enfr.spm'
  })
  t.is((request?.['config'] as Record<string, unknown>)['modelType'], 'Bergamot')
})

import test from 'brittle'
import { decideRequestSchema, ModelType } from '@qvac/inference/surface'
import { PLUGIN_DECISIONS } from '@/plugin-ids'
import { buildContract } from '../scripts/contract/build-contract'
import { contractValidate } from './utils/contract-validator'

test('decisions are a typed unary method in the generated client contract', (t) => {
  const { manifest } = buildContract()
  const method = manifest.methods.find((method) => method.name === 'decide')
  t.is(method?.callShape, 'request-reply')
  const single = {
    type: 'decide',
    modelId: 'laya',
    state: 'Refund',
    questions: { refund: { type: 'noul', instructions: 'Refund requested.' } },
    requestId: 'decision-id'
  }
  t.is(decideRequestSchema.parse(single).requestId, 'decision-id')
  t.ok(contractValidate('decide.request', single).valid)
  const { state, ...base } = single
  t.ok(contractValidate('decide.request', { ...base, states: [state] }).valid)
  t.absent(contractValidate('decide.request', { ...single, states: [state] }).valid)
  t.ok(contractValidate('constants.ModelType', ModelType.llamacppDecisions).valid)
  t.ok(contractValidate('constants.PluginId', PLUGIN_DECISIONS).valid)
})

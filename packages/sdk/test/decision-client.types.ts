import {
  decide,
  loadModel,
  LAYA_MULTILINGUAL_322M_Q8_0,
  type DecisionResult,
  type DecisionResponse,
  type DecideParams,
  type LoadModelOptions
} from '@/index'

const questions = { refund: { type: 'noul' as const, instructions: 'Refund requested.' } }
const single: Promise<DecisionResult> & { requestId: string } = decide({
  modelId: 'laya',
  state: 'Refund',
  questions
})
const batch: Promise<DecisionResult[]> & { requestId: string } = decide({
  modelId: 'laya',
  states: ['Refund'],
  questions
})
const widened: DecideParams = {} as DecideParams
const union: Promise<DecisionResponse> = decide(widened)
const load: LoadModelOptions = {
  modelSrc: '/models/laya.gguf',
  modelType: 'llamacpp-decision',
  modelConfig: { device: 'cpu', threads: 0 }
}
const defaultLoad: LoadModelOptions = {
  modelSrc: '/models/laya.gguf',
  modelType: 'llamacpp-decision'
}
const configLoad: LoadModelOptions = {
  modelSrc: '/models/laya.gguf',
  modelType: 'llamacpp-decision',
  modelConfig: { threads: 0 }
}
const constantLoad: Promise<string> & { requestId: string } = loadModel({
  modelSrc: LAYA_MULTILINGUAL_322M_Q8_0,
  modelType: 'llamacpp-decision',
  modelConfig: { device: 'cpu' }
})
void [single, batch, union, load, defaultLoad, configLoad, constantLoad]

// @ts-expect-error A state and a batch cannot be sent together.
decide({ modelId: 'laya', state: 'Refund', states: ['Refund'], questions })
// @ts-expect-error The result of a batch is an array.
const wrong: Promise<DecisionResult> = decide({ modelId: 'laya', states: ['Refund'], questions })
void wrong

import {
  decide,
  type LayaResult,
  type LayaResponse,
  type DecideParams,
  type LoadModelOptions
} from '@/index'

const questions = { refund: { type: 'noul' as const, instructions: 'Refund requested.' } }
const single: Promise<LayaResult> & { requestId: string } = decide({
  modelId: 'laya',
  state: 'Refund',
  questions
})
const batch: Promise<LayaResult[]> & { requestId: string } = decide({
  modelId: 'laya',
  states: ['Refund'],
  questions
})
const widened: DecideParams = {} as DecideParams
const union: Promise<LayaResponse> = decide(widened)
const load: LoadModelOptions = {
  modelSrc: '/models/laya.gguf',
  modelType: 'llamacpp-decisions',
  modelConfig: { device: 'cpu', threads: 0 }
}
const defaultLoad: LoadModelOptions = {
  modelSrc: '/models/laya.gguf',
  modelType: 'llamacpp-decisions'
}
const configLoad: LoadModelOptions = {
  modelSrc: '/models/laya.gguf',
  modelType: 'llamacpp-decisions',
  modelConfig: { threads: 0 }
}
void [single, batch, union, load, defaultLoad, configLoad]

// @ts-expect-error A state and a batch cannot be sent together.
decide({ modelId: 'laya', state: 'Refund', states: ['Refund'], questions })
// @ts-expect-error The result of a batch is an array.
const wrong: Promise<LayaResult> = decide({ modelId: 'laya', states: ['Refund'], questions })
void wrong

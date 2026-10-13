import test from 'brittle'
import { generateModelsFileContent } from '@/models/update-models/codegen'
import type { ProcessedModel } from '@/models/update-models/types'

function model(overrides: Partial<ProcessedModel> = {}): ProcessedModel {
  return {
    registryPath: 'org/model/model.gguf',
    registrySource: 'hf',
    blobCoreKey: 'ab',
    blobBlockOffset: 0,
    blobBlockLength: 1,
    blobByteOffset: 0,
    modelId: 'model.gguf',
    addon: 'llm',
    expectedSize: 1,
    sha256Checksum: 'cd',
    engine: 'llamacpp-completion',
    modelName: 'model',
    quantization: 'Q4_K_M',
    params: '7B',
    tags: [],
    ...overrides
  }
}

function catalogModels(source: string): Array<Record<string, string>> {
  const match = source.match(/export const models = (\[[\s\S]*\n\]) as const satisfies/)
  if (!match?.[1]) throw new Error('models array missing')
  return Function(`"use strict"; return (${match[1]})`)() as Array<Record<string, string>>
}

test('codegen emits registry strings as data', (t) => {
  const quantization = '"); throw new Error("pwned"); //'
  const params = 'a\nb"c\\d'
  const registrySource = 'src"; evil'
  const registryPath = 'path`${x}`'
  const modelId = 'id"\n'
  const output = generateModelsFileContent([
    model({ quantization, params, registrySource, registryPath, modelId })
  ])

  const models = catalogModels(output)
  const entry = models[0]
  if (!entry) throw new Error('catalog entry missing')

  t.is(entry.quantization, quantization)
  t.is(entry.params, params)
  t.is(entry.registrySource, registrySource)
  t.is(entry.registryPath, registryPath)
  t.is(entry.modelId, modelId)
  t.is(entry.engine, 'llamacpp-completion')
})

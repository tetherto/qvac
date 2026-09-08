import test from 'brittle'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas'
import { translate } from '@/plugins/ops/translate'
import type { AnyModel } from '@/runtime/model-registry'

function registerNmtBatch(modelId: string, runBatch: (texts: string[]) => Promise<string[]>) {
  registerModel(modelId, {
    model: { runBatch } as unknown as AnyModel,
    path: `/tmp/${modelId}.bin`,
    config: {},
    modelType: ModelType.nmtcppTranslation
  })
}

async function collect(modelId: string, texts: string[], requestId: string) {
  const gen = translate(
    {
      modelId,
      text: texts,
      stream: false,
      modelType: ModelType.nmtcppTranslation
    } as never,
    requestId
  )
  const yielded: string[] = []
  const it = gen[Symbol.asyncIterator]()
  for (let next = await it.next(); !next.done; next = await it.next()) yielded.push(next.value)
  return yielded
}

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}`
}

test('translate (NMT batch): yields one whole translation per input, in order', async (t) => {
  const modelId = makeId('nmt-batch')
  registerNmtBatch(modelId, async (texts) => texts.map((text) => `[${text}]`))

  const yielded = await collect(modelId, ['one', 'two', 'three'], makeId('req'))
  t.alike(yielded, ['[one]', '[two]', '[three]'], 'one entry per input, no separators')

  unregisterModel(modelId)
})

test('translate (NMT batch): a translation containing a newline stays one entry', async (t) => {
  const modelId = makeId('nmt-batch-newline')
  registerNmtBatch(modelId, async () => ['first\nsecond', 'third'])

  const yielded = await collect(modelId, ['a', 'b'], makeId('req'))
  t.alike(yielded, ['first\nsecond', 'third'], 'the newline belongs to the translation')

  unregisterModel(modelId)
})

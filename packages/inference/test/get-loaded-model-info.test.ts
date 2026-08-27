import test from 'brittle'
import { handleGetLoadedModelInfo } from '@/handlers/get-loaded-model-info'
import { ModelNotFoundError } from '@/errors'
import { ERROR_CODES } from '@/schemas'

let idCounter = 0
function makeId(prefix: string) {
  idCounter++
  return `${prefix}-${idCounter}`
}

test('getLoadedModelInfo: unknown modelId throws ModelNotFoundError', function (t) {
  const modelId = makeId('nonexistent-loaded-info')

  try {
    handleGetLoadedModelInfo({ type: 'getLoadedModelInfo', modelId })
    t.fail('Expected handleGetLoadedModelInfo to throw')
  } catch (error) {
    t.ok(error instanceof ModelNotFoundError)
    t.is((error as ModelNotFoundError).code, ERROR_CODES.MODEL_NOT_FOUND)
  }
})

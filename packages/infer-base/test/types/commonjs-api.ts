import InferBase = require('@qvac/infer-base')
import {
  QvacResponse,
  createJobHandler,
  exclusiveRunQueue,
  getApiDefinition,
  type JobHandler
} from '@qvac/infer-base'

async function cancelHandler() {}

const response = new QvacResponse<string>({ cancelHandler })
const responseConstructor: typeof QvacResponse = InferBase.QvacResponse
const handler: JobHandler = createJobHandler({ cancel: cancelHandler })
const namespaceHandler: InferBase.JobHandler = handler
const queuedResult: Promise<number> = exclusiveRunQueue()(async function run() {
  return 1
})
const apiDefinition: string = getApiDefinition()

response.onUpdate(function onUpdate(output) {
  const text: string = output
  void text
})

void [response, responseConstructor, handler, namespaceHandler, queuedResult, apiDefinition]

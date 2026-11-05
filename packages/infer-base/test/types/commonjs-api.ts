import InferBase = require('@qvac/infer-base')
import BareAbortController = require('bare-abort-controller')
import {
  QvacResponse,
  createJobHandler,
  exclusiveRunQueue,
  getApiDefinition,
  type JobHandler
} from '@qvac/infer-base'

async function cancelHandler() {}

const response = new QvacResponse<string>({ cancelHandler })
const nonRetainingResponse = new QvacResponse<string>({ cancelHandler, retainOutput: false })
const retainingResponse = new InferBase.QvacResponse<string>({ cancelHandler, retainOutput: true })
// @ts-expect-error retainOutput accepts only a boolean
new QvacResponse({ cancelHandler, retainOutput: 'false' })
const bareSignal = new BareAbortController().signal
const bareResponse = new QvacResponse<string>({ cancelHandler, signal: bareSignal })
const responseConstructor: typeof QvacResponse = InferBase.QvacResponse
const handler: JobHandler = createJobHandler({ cancel: cancelHandler })
handler.start({ signal: bareSignal })
handler.start({ signal: bareSignal, retainOutput: false })
// @ts-expect-error retainOutput accepts only a boolean
handler.start({ retainOutput: 'false' })
const namespaceHandler: InferBase.JobHandler = handler
namespaceHandler.start({ retainOutput: true })
const queuedResult: Promise<number> = exclusiveRunQueue()(async function run() {
  return 1
})
const apiDefinition: string = getApiDefinition()

// Signals predating `AbortSignal.reason` omit the property entirely, so they
// must stay assignable to the published abort-signal contract.
const reasonlessSignal: InferBase.AbortSignalLike = {
  aborted: false,
  addEventListener(type: 'abort', listener: () => void) {
    void [type, listener]
  },
  removeEventListener(type: 'abort', listener: () => void) {
    void [type, listener]
  }
}
const reasonlessResponse = new QvacResponse<string>({
  cancelHandler,
  signal: reasonlessSignal
})
handler.start({ signal: reasonlessSignal })

response.onUpdate(function onUpdate(output) {
  const text: string = output
  void text
})

const latest = response.getLatest()
// @ts-expect-error getLatest can return null before the first output
const uncheckedLatest: string = latest
if (latest !== null) {
  const checkedLatest: string = latest
  void checkedLatest
}

void [
  response,
  nonRetainingResponse,
  retainingResponse,
  bareResponse,
  reasonlessResponse,
  responseConstructor,
  handler,
  namespaceHandler,
  queuedResult,
  apiDefinition,
  uncheckedLatest
]

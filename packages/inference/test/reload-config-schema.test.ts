import test from 'brittle'
import { reloadConfigOptionsToRequestSchema } from '@/schemas/reload-config'

// A reload is registered under the request id the client minted, so the
// request built from the client's options must keep it for
// `cancel({ requestId })` to reach the reload.

test('reload request: the client request id reaches the wire', (t) => {
  const request = reloadConfigOptionsToRequestSchema.parse({
    modelId: 'a1b2c3d4e5f60718',
    modelType: 'whispercpp-transcription',
    modelConfig: { language: 'en' },
    requestId: 'reload-1'
  })
  t.is(request.requestId, 'reload-1')
})

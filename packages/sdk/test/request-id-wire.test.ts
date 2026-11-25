import test from 'brittle'
import {
  loadModelOptionsToRequestSchema,
  downloadAssetOptionsToRequestSchema,
  bciTranscribeStreamRequestSchema,
  startRpcServerRequestSchema,
  discoverRpcServersRequestSchema
} from '@qvac/inference/surface'
import { ModelType } from '@qvac/sdk'

test('RPC control requests preserve caller IDs and allow legacy requests without them', (t) => {
  for (const [schema, request] of [
    [startRpcServerRequestSchema, { type: 'startRpcServer' }],
    [discoverRpcServersRequestSchema, { type: 'discoverRpcServers', topic: 'cancel-test' }]
  ] as const) {
    t.is(schema.parse({ ...request, requestId: 'client-rpc-id' }).requestId, 'client-rpc-id')
    t.is(schema.parse(request).requestId, undefined)
    t.absent(schema.safeParse({ ...request, requestId: '' }).success)
  }
})

// -----------------------------------------------------------------------------
// requestId wire-shape round-trip — schema half.
//
// The decorated-promise contract says: the client generates a
// `requestId` once, the request envelope carries it on the wire, and
// the server uses that same value as the registry-entry key. These
// tests pin the **envelope half** — that the request schemas accept
// and preserve `requestId` for `loadModel` and `downloadAsset`.
//
// The handler-side half (server keys the registry on the client's
// `requestId`) is exercised by the per-handler tests in
// `request-registry.test.ts` + the dispatcher-level cancel arm in
// `cancelHandler.ts`.
// -----------------------------------------------------------------------------

test('loadModelOptionsToRequestSchema: forwards requestId onto the wire envelope', (t) => {
  const parsed = loadModelOptionsToRequestSchema.parse({
    modelType: ModelType.llamacppCompletion,
    modelSrc: '/tmp/model.gguf',
    requestId: 'client-uuid-load'
  })
  t.is(
    (parsed as { requestId?: string }).requestId,
    'client-uuid-load',
    'loadModel envelope must carry the client-generated requestId'
  )
})

test('loadModelOptionsToRequestSchema: requestId is optional (legacy clients)', (t) => {
  const parsed = loadModelOptionsToRequestSchema.parse({
    modelType: ModelType.llamacppCompletion,
    modelSrc: '/tmp/model.gguf'
  })
  t.is(
    (parsed as { requestId?: string }).requestId,
    undefined,
    'missing requestId stays undefined on the envelope — server falls back to server-generated id'
  )
})

test('downloadAssetOptionsToRequestSchema: forwards requestId onto the wire envelope', (t) => {
  const parsed = downloadAssetOptionsToRequestSchema.parse({
    assetSrc: '/tmp/asset.bin',
    requestId: 'client-uuid-dl'
  })
  t.is(
    (parsed as { requestId?: string }).requestId,
    'client-uuid-dl',
    'downloadAsset envelope must carry the client-generated requestId'
  )
})

test('downloadAssetOptionsToRequestSchema: requestId is optional', (t) => {
  const parsed = downloadAssetOptionsToRequestSchema.parse({
    assetSrc: '/tmp/asset.bin'
  })
  t.is((parsed as { requestId?: string }).requestId, undefined)
})

test('bciTranscribeStreamRequestSchema: forwards requestId onto the wire envelope', (t) => {
  const parsed = bciTranscribeStreamRequestSchema.parse({
    type: 'bciTranscribeStream',
    modelId: 'model-bci',
    requestId: 'client-uuid-bci-stream'
  })
  t.is(
    (parsed as { requestId?: string }).requestId,
    'client-uuid-bci-stream',
    'BCI stream envelope must carry the client-generated requestId'
  )
})

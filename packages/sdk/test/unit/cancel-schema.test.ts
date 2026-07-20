import test from 'brittle'
import { cancelBroadSugarSchema, cancelRequestSchema } from '@/schemas/cancel'
import type { RequestKind } from '@/server/bare/runtime/request-context'

// Compile-time exhaustive map of every server-side `RequestKind`. Adding a
// new kind to the union without a matching entry here is a TS error, which
// forces this guard — and, via the assertions below, `cancelKindSchema` — to
// stay in sync with the `RequestKind` union the schema comment says it mirrors.
const ALL_REQUEST_KINDS: Record<RequestKind, true> = {
  completion: true,
  batchCompletion: true,
  embeddings: true,
  transcribe: true,
  translate: true,
  diffusion: true,
  tts: true,
  ocr: true,
  vla: true,
  finetune: true,
  loadModel: true,
  downloadAsset: true,
  rag: true
}

test('broad-cancel sugar accepts every RequestKind', (t) => {
  for (const kind of Object.keys(ALL_REQUEST_KINDS) as RequestKind[]) {
    const result = cancelBroadSugarSchema.safeParse({ modelId: 'm1', kind })
    t.is(result.success, true, `cancel({ modelId, kind: "${kind}" }) should parse`)
  }
})

test('cancel wire schema accepts kind: batchCompletion', (t) => {
  const result = cancelRequestSchema.safeParse({
    type: 'cancel',
    operation: 'broad',
    modelId: 'm1',
    kind: 'batchCompletion'
  })
  t.is(result.success, true)
})

test('broad-cancel sugar rejects an unknown kind', (t) => {
  const result = cancelBroadSugarSchema.safeParse({
    modelId: 'm1',
    kind: 'notAKind'
  })
  t.is(result.success, false)
})

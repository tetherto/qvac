import test from 'brittle'
import { getRequestRegistry } from '@/server/bare/runtime'

// The worker singleton must register finetune as an exclusive writer over the
// completion lane, so no completion runs on the model while a finetune does —
// which is what makes finetune's only-global cancel safe.
test('singleton: finetune is admitted exclusively over the completion lane', async (t) => {
  const r = getRequestRegistry()
  // Unique model id so this test doesn't contend with others on the shared
  // singleton.
  const modelId = `singleton-rw-${Date.now()}`

  const ft = await r.begin({ requestId: `ft-${modelId}`, kind: 'finetune', modelId })

  let completionAdmitted = false
  const completionP = r
    .begin({ requestId: `c-${modelId}`, kind: 'completion', modelId, maxConcurrentPerModel: 2 })
    .then((ctx) => {
      completionAdmitted = true
      return ctx
    })
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(completionAdmitted, false, 'a completion queues while the finetune holds the model')

  await ft[Symbol.asyncDispose]()
  const completion = await completionP
  t.is(completionAdmitted, true, 'the completion is admitted once the finetune releases')

  await completion[Symbol.asyncDispose]()
})

// LLM translate joins the completion lane (gated per request), so a finetune's
// exclusivity blocks it too; NMT translate passes no cap and stays ungated.
test('singleton: an llm-translate reader is blocked by an exclusive finetune', async (t) => {
  const r = getRequestRegistry()
  const modelId = `singleton-rw-tr-${Date.now()}`

  const ft = await r.begin({ requestId: `ft-${modelId}`, kind: 'finetune', modelId })

  let translateAdmitted = false
  const translateP = r
    .begin({ requestId: `tr-${modelId}`, kind: 'translate', modelId, maxConcurrentPerModel: 2 })
    .then((ctx) => {
      translateAdmitted = true
      return ctx
    })
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(translateAdmitted, false, 'an llm-translate reader queues behind the finetune writer')

  await ft[Symbol.asyncDispose]()
  const translate = await translateP
  t.is(translateAdmitted, true, 'the translate is admitted once the finetune releases')

  await translate[Symbol.asyncDispose]()
})

test('singleton: NMT translate (no cap) is ungated and not blocked by a finetune', async (t) => {
  const r = getRequestRegistry()
  const modelId = `singleton-nmt-${Date.now()}`

  const ft = await r.begin({ requestId: `ft-${modelId}`, kind: 'finetune', modelId })

  // No maxConcurrentPerModel → the translate policy's default cap is Infinity →
  // ungated, so it is admitted immediately even alongside the exclusive writer.
  const nmt = await r.begin({ requestId: `nmt-${modelId}`, kind: 'translate', modelId })
  t.ok(nmt, 'ungated NMT translate is admitted immediately')

  await nmt[Symbol.asyncDispose]()
  await ft[Symbol.asyncDispose]()
})

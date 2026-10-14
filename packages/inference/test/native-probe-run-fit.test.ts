import test from 'brittle'
import { AbortController } from 'bare-abort-controller'

import type { FitProbeRequest } from '@/resources/model-fit/native-probe/engine-fit'
import { runFit } from '@/resources/model-fit/native-probe/run-fit'

const PROBE: FitProbeRequest = {
  engine: 'llm-llamacpp',
  request: { modelPath: '/models/model.gguf', params: { 'ctx-size': '4096' } }
}

// Neither strategy reaches a fitter here, so the outcome is `unknown` either
// way: the subprocess supervisor refuses an unsupported platform, and the
// in-process path has no model to read.
test('a host that can spawn a child gets the process boundary', async (t) => {
  const result = await runFit(PROBE, {
    mobile: false,
    timeoutMs: 50
  })

  t.is(result.status, 'unknown')
})

test('the caller timeout and signal reach the chosen strategy', async (t) => {
  const controller = new AbortController()
  controller.abort(undefined)

  const result = await runFit(PROBE, { mobile: true, signal: controller.signal })

  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'cancelled')
})

test('an aborted caller is cancelled on the process path too', async (t) => {
  const controller = new AbortController()
  controller.abort(undefined)

  const result = await runFit(PROBE, { mobile: false, signal: controller.signal })

  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'cancelled')
})

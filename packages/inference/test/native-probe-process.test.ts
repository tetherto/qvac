import test from 'brittle'
import { fileURLToPath } from 'bare-url'

import { runIsolatedFit } from '@/resources/model-fit/native-probe/run-isolated-fit'

// The engine always runs under Bare, so unlike the pre-relocation SDK suite
// there is no Node-parent variant: this test IS the Bare parent, driving one
// real disposable child per case through the actual `bare` spawn path.
//
// Resolved against the compiled test's own location: the fixture compiles to
// ./fixtures/native-probe/fit-runner-fixture.js beside it under test/dist.
const runnerFixturePath = fileURLToPath(
  new URL('./fixtures/native-probe/fit-runner-fixture.js', import.meta.url)
)

function run(mode: 'completed' | 'error' | 'hang' | 'abort') {
  return runIsolatedFit(
    { engine: 'llm-llamacpp', request: { modelPath: '/tmp/not-used.gguf' } },
    {
      runnerPath: runnerFixturePath,
      runnerArgs: [mode],
      timeoutMs: 2_000,
      terminationGraceMs: 200,
      finalKillGraceMs: 200
    }
  )
}

test('process: a real child returning a valid response completes', async (t) => {
  const result = await run('completed')

  t.is(result.status, 'completed')
  if (result.status === 'completed') {
    t.is(result.probe.engine, 'llm-llamacpp')
    t.is(result.probe.result.status, 'fits')
  }
})

test('process: a real child exiting abnormally is unknown/crashed', async (t) => {
  const result = await run('error')

  t.is(result.status, 'unknown')
  if (result.status === 'unknown') {
    t.is(result.reason, 'crashed')
    t.ok((result.stderrTail ?? '').includes('fixture failed'))
  }
})

test('process: a hung child is terminated and reported as timeout', async (t) => {
  const result = await run('hang')

  t.is(result.status, 'unknown')
  if (result.status === 'unknown') {
    t.is(result.reason, 'timeout')
  }
})

test('process: a child killed by a signal is unknown/crashed', async (t) => {
  const result = await run('abort')

  t.is(result.status, 'unknown')
  if (result.status === 'unknown') {
    t.is(result.reason, 'crashed')
  }
})

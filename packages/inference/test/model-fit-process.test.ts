import test from 'brittle'
import { fileURLToPath } from 'bare-url'

import { runIsolatedFit } from '@/model-fit/run-isolated-fit'

// The engine always runs under Bare, so unlike the pre-relocation SDK suite
// there is no Node-parent variant: this test IS the Bare parent, driving one
// real disposable child per case through the actual `bare` spawn path.
//
// Resolved against the compiled test's own location: the fixture compiles to
// ./fixtures/model-fit/fit-runner-fixture.js beside it under test/dist.
// `import.meta` is not modeled by this package's TS libs; the compiled test
// runs as ESM under Bare where it exists.
const testModuleUrl = (import.meta as unknown as { url: string }).url
const runnerFixturePath = fileURLToPath(
  new URL('./fixtures/model-fit/fit-runner-fixture.js', testModuleUrl)
)

function run(mode: 'completed' | 'error' | 'hang' | 'abort') {
  return runIsolatedFit(
    'completion',
    { modelPath: '/tmp/not-used.gguf', params: { device: 'gpu' } },
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
    t.is(result.result.status, 0)
    t.is(result.result.nCtx, 4096)
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

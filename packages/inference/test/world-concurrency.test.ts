import test from 'brittle'
import { getRequestRegistry } from '@/runtime/index'
import { RequestRejectedByPolicyError } from '@/errors/index'

// Exercises the policy the SDK actually installs, not a locally-built one:
// an ABot-World session runs a single native job at a time, and both world
// operations share the lane.
test('world admission: a second world request on the same model is rejected, not queued', async (t) => {
  const registry = getRequestRegistry()

  await using walking = await registry.begin({
    requestId: 'world-step-1',
    kind: 'world',
    modelId: 'world-model'
  })
  t.is(walking.requestId, 'world-step-1')

  // A walk is driven by live key input, so a backlog of stale keypresses is
  // worse for the caller than a refusal it can drop. This also covers a scene
  // creation arriving mid-walk: both use the one `world` kind.
  await t.exception(
    () => registry.begin({ requestId: 'world-step-2', kind: 'world', modelId: 'world-model' }),
    RequestRejectedByPolicyError as unknown as new () => Error,
    'overlapping world request is refused'
  )

  t.is(registry.list().length, 1, 'the refused request left no slot behind')
})

test('world admission: a different model is unaffected', async (t) => {
  const registry = getRequestRegistry()

  await using first = await registry.begin({
    requestId: 'world-a',
    kind: 'world',
    modelId: 'world-model-a'
  })
  await using second = await registry.begin({
    requestId: 'world-b',
    kind: 'world',
    modelId: 'world-model-b'
  })

  t.is(first.requestId, 'world-a')
  t.is(second.requestId, 'world-b', 'the limit is per model, not global')
})

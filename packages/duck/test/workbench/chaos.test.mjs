import assert from 'node:assert/strict'
import test from 'node:test'
import { session } from './helpers/chaos.mjs'

// CHAOS_SEEDS and CHAOS_STEPS make a soak run; CHAOS_SEED replays one failure exactly.
const SEEDS = Number(process.env.CHAOS_SEEDS || 60)
const STEPS = Number(process.env.CHAOS_STEPS || 150)
const ONLY = process.env.CHAOS_SEED

test('random keys, pastes, mouse, resizes and engine events never break the app', async () => {
  const unhandled = []
  const onRejection = (error) => unhandled.push(error)
  process.on('unhandledRejection', onRejection)
  const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, i) => i + 1)
  try {
    for (const seed of seeds) {
      const failure = await session(seed, STEPS)
      assert.equal(failure, null, failure && report(failure))
    }

    assert.deepEqual(unhandled.map(String), [], 'no promise was left to reject unseen')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

function report({ seed, step, error, trail }) {
  return [
    `seed ${seed}, step ${step}: ${error}`,
    `replay: CHAOS_SEED=${seed} CHAOS_STEPS=${step + 1} node --test test/chaos.test.mjs`,
    'last actions:',
    ...trail.map((t) => '  ' + t)
  ].join('\n')
}

import assert from 'node:assert/strict'
import test from 'node:test'

import { artifactRoot, serverArgs, startServer } from '../index.js'

test('serverArgs points artifacts at the staged package', () => {
  const args = serverArgs({
    model: '/models/qwen',
    host: '127.0.0.1',
    port: 30000,
    tpSize: 2,
    cudaGraph: true
  })
  assert.deepEqual(args, [
    '--model',
    '/models/qwen',
    '--artifacts',
    artifactRoot(),
    '--host',
    '127.0.0.1',
    '--port',
    '30000',
    '--tp-size',
    '2',
    '--cuda-graph'
  ])
})

test('serverArgs keeps an explicit artifact directory', () => {
  assert.deepEqual(serverArgs({ model: '/models/qwen', artifacts: '/custom' }), [
    '--model',
    '/models/qwen',
    '--artifacts',
    '/custom'
  ])
})

test('startServer reports a missing staged binary before spawning', () => {
  assert.throws(() => startServer({ model: '/models/qwen' }), /not staged/)
})

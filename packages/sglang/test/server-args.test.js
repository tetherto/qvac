import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { artifactRoot, serverArgs } from '../index.js'

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
    '2'
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

test('serverArgs disables CUDA graphs when requested', () => {
  assert.ok(serverArgs({ cudaGraph: false }).includes('--disable-cuda-graph'))
})

test('startServer reports a missing staged binary before spawning', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-sglang-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.copyFileSync(
    fileURLToPath(new URL('../index.js', import.meta.url)),
    path.join(dir, 'index.mjs')
  )
  const { startServer } = await import(pathToFileURL(path.join(dir, 'index.mjs')).href)
  assert.throws(() => startServer({ model: '/models/qwen' }), /not staged/)
})

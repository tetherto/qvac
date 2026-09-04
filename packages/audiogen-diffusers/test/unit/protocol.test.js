'use strict'

const test = require('brittle')
const {
  MAX_REQUEST_BYTES,
  PROTOCOL_VERSION,
  encodeWorkerRequest,
  parseWorkerRequest
} = require('../../protocol')

test('MiniMax Diffusers protocol encodes a versioned load request', (t) => {
  const line = encodeWorkerRequest({
    version: PROTOCOL_VERSION,
    op: 'load',
    config: { modelDir: '/models/minimax' }
  })

  t.ok(line.endsWith('\n'))
  t.alike(JSON.parse(line), {
    version: PROTOCOL_VERSION,
    op: 'load',
    config: {
      modelDir: '/models/minimax',
      device: 'cuda',
      torchDtype: 'bfloat16'
    }
  })
})

test('MiniMax Diffusers protocol validates generation controls', async (t) => {
  await t.exception.all(
    () => parseWorkerRequest({
      version: PROTOCOL_VERSION,
      op: 'generate',
      requestId: 'request',
      caption: 'music',
      lyrics: '[instrumental]',
      maxFrames: 0
    }),
    /maxFrames must be a positive safe integer/
  )
})

test('MiniMax Diffusers protocol bounds request size', async (t) => {
  await t.exception.all(
    () => encodeWorkerRequest({
      version: PROTOCOL_VERSION,
      op: 'generate',
      requestId: 'request',
      caption: 'x'.repeat(MAX_REQUEST_BYTES),
      lyrics: '[instrumental]',
      maxFrames: 1
    }),
    /worker request exceeds 64 KiB/
  )
})

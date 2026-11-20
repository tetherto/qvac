import test from 'brittle'
import { createVideoStreamRequest } from '@/api/video-request'

test('video client: forwards H3 frames and preserves omitted native defaults', (t) => {
  const base = { modelId: 'h3', mode: 'txt2vid' as const, prompt: 'Steam rises from coffee.' }
  const request = createVideoStreamRequest(
    { ...base, videoFrames: 124, fps: 24, cfgScale: 1, scheduler: 'discrete' },
    'h3-request'
  )
  t.is(request.videoFrames, 124)
  t.is(request.fps, 24)
  t.is(request.cfgScale, 1)
  t.is(request.scheduler, 'discrete')
  const defaults = createVideoStreamRequest(base, 'h3-defaults')
  for (const field of ['videoFrames', 'fps', 'cfgScale', 'scheduler', 'steps'] as const) {
    t.is(defaults[field], undefined)
  }
})

test('video client: base64-encodes the LTX reference sheet', (t) => {
  const request = createVideoStreamRequest(
    {
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'Reference sheet: an explorer. Generated video: the explorer crosses a ridge.',
      lora: '/models/adapter.safetensors',
      referenceImages: [new Uint8Array([1, 2, 3])],
      videoFrames: 121
    },
    'request-1'
  )

  t.alike(request.referenceImages, ['AQID'])
  t.is(request.requestId, 'request-1')
  t.is(request.type, 'videoStream')
})

test('video client: omits referenceImages when not supplied', (t) => {
  const request = createVideoStreamRequest(
    {
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a running fox'
    },
    'request-2'
  )

  t.is('referenceImages' in request, false)
})

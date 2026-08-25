import test from 'brittle'
import { createVideoStreamRequest } from '@/api/video-request'

test('video client: base64-encodes the LTX reference sheet', (t) => {
  const request = createVideoStreamRequest(
    {
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'Reference sheet: an explorer. Generated video: the explorer crosses a ridge.',
      lora: '/models/adapter.safetensors',
      reference_images: [new Uint8Array([1, 2, 3])],
      video_frames: 121
    },
    'request-1'
  )

  t.alike(request.reference_images, ['AQID'])
  t.is(request.requestId, 'request-1')
  t.is(request.type, 'videoStream')
})

test('video client: omits reference_images when not supplied', (t) => {
  const request = createVideoStreamRequest(
    {
      modelId: 'model-1',
      mode: 'txt2vid',
      prompt: 'a running fox'
    },
    'request-2'
  )

  t.is('reference_images' in request, false)
})

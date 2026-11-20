import test from 'brittle'
import { validateConfig } from '@/client/config-loader/config-utils'

test('validateConfig: legacy device-default keys load as their camelCase replacement', function (t) {
  const config = validateConfig({
    deviceDefaults: [
      {
        name: 'Pixel',
        match: { platform: 'android' },
        defaults: {
          llm: { ctx_size: 2048, 'flash-attn': 'off' },
          'whispercpp-transcription': { contextParams: { use_gpu: false } }
        }
      }
    ]
  })
  t.alike(config.deviceDefaults?.[0]?.defaults, {
    llm: { ctxSize: 2048, flashAttention: 'off' },
    'whispercpp-transcription': { contextParams: { useGpu: false } }
  })
})

import type { VideoClientParams } from '@qvac/inference/surface'

function acceptVideoParams(_params: VideoClientParams) {}

acceptVideoParams({
  modelId: 'h3',
  mode: 'txt2vid',
  prompt: 'Steam rises from coffee.',
  videoFrames: 124,
  fps: 24,
  cfgScale: 1,
  scheduler: 'discrete'
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  referenceImages: [new Uint8Array([1])],
  videoFrames: 121,
  referenceAttentionStrength: 1,
  referenceDownscaleFactor: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  loraStrength: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  initImage: new Uint8Array([1]),
  lora: '/models/adapter.safetensors',
  loraStrength: 1
})

// @ts-expect-error loraStrength requires lora
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  loraStrength: 1
})

// @ts-expect-error loraStrength requires lora for img2vid too
acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  initImage: new Uint8Array([1]),
  loraStrength: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  videoFrames: 121,
  // @ts-expect-error reference conditioning requires exactly one image
  referenceImages: []
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  videoFrames: 121,
  // @ts-expect-error reference conditioning requires exactly one image
  referenceImages: [new Uint8Array([1]), new Uint8Array([2])]
})

// @ts-expect-error reference fields require referenceImages
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  referenceAttentionStrength: 1
})

// @ts-expect-error referenceImages requires lora
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  referenceImages: [new Uint8Array([1])] as const,
  videoFrames: 121
})

// @ts-expect-error referenceImages requires explicit videoFrames
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  referenceImages: [new Uint8Array([1])] as const
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  initImage: new Uint8Array([1]),
  // @ts-expect-error img2vid does not accept reference conditioning
  referenceImages: [new Uint8Array([2])]
})

// @ts-expect-error img2vid does not accept reference attention
acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  initImage: new Uint8Array([1]),
  referenceAttentionStrength: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  initImage: new Uint8Array([1]),
  // @ts-expect-error img2vid does not accept reference downscale
  referenceDownscaleFactor: 1
})

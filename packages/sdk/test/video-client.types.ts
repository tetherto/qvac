import type { VideoClientParams } from '@qvac/inference/surface'

function acceptVideoParams(_params: VideoClientParams) {}

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  reference_images: [new Uint8Array([1])],
  video_frames: 121,
  reference_attention_strength: 1,
  reference_downscale_factor: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  lora_strength: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  init_image: new Uint8Array([1]),
  lora: '/models/adapter.safetensors',
  lora_strength: 1
})

// @ts-expect-error lora_strength requires lora
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora_strength: 1
})

// @ts-expect-error lora_strength requires lora for img2vid too
acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  init_image: new Uint8Array([1]),
  lora_strength: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  video_frames: 121,
  // @ts-expect-error reference conditioning requires exactly one image
  reference_images: []
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  video_frames: 121,
  // @ts-expect-error reference conditioning requires exactly one image
  reference_images: [new Uint8Array([1]), new Uint8Array([2])]
})

// @ts-expect-error reference fields require reference_images
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  reference_attention_strength: 1
})

// @ts-expect-error reference_images requires lora
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  reference_images: [new Uint8Array([1])] as const,
  video_frames: 121
})

// @ts-expect-error reference_images requires explicit video_frames
acceptVideoParams({
  modelId: 'model-1',
  mode: 'txt2vid',
  prompt: 'an explorer',
  lora: '/models/adapter.safetensors',
  reference_images: [new Uint8Array([1])] as const
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  init_image: new Uint8Array([1]),
  // @ts-expect-error img2vid does not accept reference conditioning
  reference_images: [new Uint8Array([2])]
})

// @ts-expect-error img2vid does not accept reference attention
acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  init_image: new Uint8Array([1]),
  reference_attention_strength: 1
})

acceptVideoParams({
  modelId: 'model-1',
  mode: 'img2vid',
  prompt: 'animate this frame',
  init_image: new Uint8Array([1]),
  // @ts-expect-error img2vid does not accept reference downscale
  reference_downscale_factor: 1
})

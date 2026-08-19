import type { Expectation, TestDefinition } from '@qvac/qvac-test-suite'

export interface VideoIcLoraContractParams {
  mode: 'txt2vid'
  prompt: string
  lora: string
  lora_strength: number
  stg_scale: number
  stg_block: number
  reference_images: [number[]]
  reference_attention_strength: number
  reference_downscale_factor: 1
  video_frames: number
  scheduler: 'ltx2'
  [key: string]: unknown
}

export type VideoIcLoraContractTestDef<TId extends string> = TestDefinition & {
  testId: TId
  params: VideoIcLoraContractParams
}

function createVideoIcLoraContractTest<const TId extends string>(
  testId: TId,
  params: VideoIcLoraContractParams,
  expectation: Expectation
): VideoIcLoraContractTestDef<TId> {
  return {
    testId,
    params,
    expectation,
    metadata: {
      category: 'video',
      dependency: 'echo',
      estimatedDurationMs: 10000
    }
  }
}

export const videoIcLoraContractHappy = createVideoIcLoraContractTest(
  'video-ic-lora-contract-happy',
  {
    mode: 'txt2vid',
    prompt:
      'Reference sheet: a red-haired explorer. Generated video: the explorer crosses a snowy ridge.',
    lora: '/models/ltx-2-ingredients.safetensors',
    lora_strength: 1.37,
    stg_scale: 1,
    stg_block: 29,
    reference_images: [[1, 2, 3]],
    reference_attention_strength: 1,
    reference_downscale_factor: 1,
    video_frames: 121,
    scheduler: 'ltx2'
  },
  {
    validation: 'contains-all',
    contains: ['ICLORA', 'VIDEO']
  }
)

export const videoIcLoraContractLowerBoundaries = createVideoIcLoraContractTest(
  'video-ic-lora-contract-lower-boundaries',
  {
    mode: 'txt2vid',
    prompt: 'Reference sheet: a subject. Generated video: the subject waves.',
    lora: '/models/ltx-2-ingredients.safetensors',
    lora_strength: 0,
    stg_scale: 0,
    stg_block: 0,
    reference_images: [[0]],
    reference_attention_strength: 0,
    reference_downscale_factor: 1,
    video_frames: 121,
    scheduler: 'ltx2'
  },
  {
    validation: 'contains-all',
    contains: ['ICLORA', 'VIDEO']
  }
)

export const videoIcLoraContractRelativeLoraError = createVideoIcLoraContractTest(
  'video-ic-lora-contract-relative-lora-error',
  {
    mode: 'txt2vid',
    prompt: 'Reference sheet: a subject. Generated video: the subject waves.',
    lora: 'models/ltx-2-ingredients.safetensors',
    lora_strength: 1.37,
    stg_scale: 1,
    stg_block: 29,
    reference_images: [[1, 2, 3]],
    reference_attention_strength: 1,
    reference_downscale_factor: 1,
    video_frames: 121,
    scheduler: 'ltx2'
  },
  {
    validation: 'throws-error',
    errorContains: 'lora must be an absolute path'
  }
)

export const videoIcLoraContractTests = [
  videoIcLoraContractHappy,
  videoIcLoraContractLowerBoundaries,
  videoIcLoraContractRelativeLoraError
] as const

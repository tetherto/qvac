import {
  ModelTypeAliases,
  normalizeModelType,
  type CanonicalModelType
} from '@/schemas/model-types'
import { inferModelTypeFromModelSrc } from '@/schemas/model-src-utils'
import type { LlmConfigInput } from '@/schemas/llamacpp-config'
import type { GenerationParams, ResponseFormat } from '@/schemas/completion-stream'
import type { DecisionConfigInput } from '@/schemas/decision'
import type { RerankConfigInput } from '@/schemas/rerank'
import type { WhisperConfig } from '@/schemas/transcription-config'
import type { BciConfig } from '@/schemas/bci-config'
import type {
  DiffusionClientParams,
  SdcppConfig,
  VideoClientParams,
  VideoImg2vidClientParams
} from '@/schemas/sdcpp-config'

export interface LegacyLlmConfig {
  /** @deprecated Use `ctxSize`. */
  ctx_size?: LlmConfigInput['ctxSize']
  /** @deprecated Use `temperature`. */
  temp?: LlmConfigInput['temperature']
  /** @deprecated Use `topP`. */
  top_p?: LlmConfigInput['topP']
  /** @deprecated Use `topK`. */
  top_k?: LlmConfigInput['topK']
  /** @deprecated Use `gpuLayers`. */
  gpu_layers?: LlmConfigInput['gpuLayers']
  /** @deprecated Use `systemPrompt`. */
  system_prompt?: LlmConfigInput['systemPrompt']
  /** @deprecated Use `loadMode`. */
  load_mode?: LlmConfigInput['loadMode']
  /** @deprecated Use `presencePenalty`. */
  presence_penalty?: LlmConfigInput['presencePenalty']
  /** @deprecated Use `frequencyPenalty`. */
  frequency_penalty?: LlmConfigInput['frequencyPenalty']
  /** @deprecated Use `repeatPenalty`. */
  repeat_penalty?: LlmConfigInput['repeatPenalty']
  /** @deprecated Use `stopSequences`. */
  stop_sequences?: LlmConfigInput['stopSequences']
  /** @deprecated Use `cacheCheckpoints`. */
  cache_checkpoints?: LlmConfigInput['cacheCheckpoints']
  /** @deprecated Use `cacheCheckpointsMaxBytes`. */
  cache_checkpoints_max_bytes?: LlmConfigInput['cacheCheckpointsMaxBytes']
  /** @deprecated Use `cacheCheckpointStorage`. */
  cache_checkpoint_storage?: LlmConfigInput['cacheCheckpointStorage']
  /** @deprecated Use `cacheCheckpointDir`. */
  cache_checkpoint_dir?: LlmConfigInput['cacheCheckpointDir']
  /** @deprecated Use `cacheShareAcrossKeys`. */
  cache_share_across_keys?: LlmConfigInput['cacheShareAcrossKeys']
  /** @deprecated Use `cacheRamMib`. */
  cache_ram_mib?: LlmConfigInput['cacheRamMib']
  /** @deprecated Use `cacheTypeK`. */
  'cache-type-k'?: LlmConfigInput['cacheTypeK']
  /** @deprecated Use `cacheTypeV`. */
  'cache-type-v'?: LlmConfigInput['cacheTypeV']
  /** @deprecated Use `mainGpu`. */
  'main-gpu'?: LlmConfigInput['mainGpu']
  /** @deprecated Use `rpcServers`. */
  'rpc-servers'?: LlmConfigInput['rpcServers']
  /** @deprecated Use `splitMode`. */
  'split-mode'?: LlmConfigInput['splitMode']
  /** @deprecated Use `flashAttention`. */
  'flash-attn'?: LlmConfigInput['flashAttention']
  /** @deprecated Use `tensorSplit`. */
  'tensor-split'?: LlmConfigInput['tensorSplit']
  /** @deprecated Use `batchSize`. */
  'batch-size'?: LlmConfigInput['batchSize']
  /** @deprecated Use `ubatchSize`. */
  'ubatch-size'?: LlmConfigInput['ubatchSize']
  /** @deprecated Use `cpuMoe`. */
  'cpu-moe'?: LlmConfigInput['cpuMoe']
  /** @deprecated Use `nCpuMoe`. */
  'n-cpu-moe'?: LlmConfigInput['nCpuMoe']
  /** @deprecated Use `kvOffload`. */
  'kv-offload'?: LlmConfigInput['kvOffload']
  /** @deprecated Use `imageMaxTokens`. */
  'image-max-tokens'?: LlmConfigInput['imageMaxTokens']
  /** @deprecated Use `imageMinTokens`. */
  'image-min-tokens'?: LlmConfigInput['imageMinTokens']
  /** @deprecated Use `imageMaxMegapixels`. */
  'image-max-megapixels'?: LlmConfigInput['imageMaxMegapixels']
  /** @deprecated Use `threadsBatch`. */
  'threads-batch'?: LlmConfigInput['threadsBatch']
  /** @deprecated Use `cpuMask`. */
  'cpu-mask'?: LlmConfigInput['cpuMask']
  /** @deprecated Use `cpuMaskBatch`. */
  'cpu-mask-batch'?: LlmConfigInput['cpuMaskBatch']
  /** @deprecated Use `overrideTensor`. */
  'override-tensor'?: LlmConfigInput['overrideTensor']
  /** @deprecated Use `nCpuFfn`. */
  'n-cpu-ffn'?: LlmConfigInput['nCpuFfn']
  /** @deprecated Use `moeCacheMib`. */
  'moe-cache-mib'?: LlmConfigInput['moeCacheMib']
  /** @deprecated Use `prefetchWeights`. */
  'prefetch-weights'?: LlmConfigInput['prefetchWeights']
  /** @deprecated Use `tensorReadLazy`. */
  'tensor-read-lazy'?: LlmConfigInput['tensorReadLazy']
  /** @deprecated Use `coremlFfn`. */
  'coreml-ffn'?: LlmConfigInput['coremlFfn']
  /** @deprecated Use `coremlFfnSplit`. */
  'coreml-ffn-split'?: LlmConfigInput['coremlFfnSplit']
  /** @deprecated Use `coremlFfnCache`. */
  'coreml-ffn-cache'?: LlmConfigInput['coremlFfnCache']
  /** @deprecated Use `fitTarget`. */
  'fit-target'?: LlmConfigInput['fitTarget']
  /** @deprecated Use `fitCtx`. */
  'fit-ctx'?: LlmConfigInput['fitCtx']
  /** @deprecated Use `reasoningBudget`. */
  reasoning_budget?: LlmConfigInput['reasoningBudget']
  /** @deprecated Use `specType`. */
  spec_type?: LlmConfigInput['specType']
  /** @deprecated Use `specDraftNMax`. */
  spec_draft_n_max?: LlmConfigInput['specDraftNMax']
  /** @deprecated Use `specDraftNMin`. */
  spec_draft_n_min?: LlmConfigInput['specDraftNMin']
  /** @deprecated Use `specDraftPMin`. */
  spec_draft_p_min?: LlmConfigInput['specDraftPMin']
  /** @deprecated Use `imageTileMode`. */
  image_tile_mode?: LlmConfigInput['imageTileMode']
  /** @deprecated Use `imageNoUpscale`. */
  image_no_upscale?: LlmConfigInput['imageNoUpscale']
  /** @deprecated Use `mmprojUseGpu`. */
  'mmproj-use-gpu'?: LlmConfigInput['mmprojUseGpu']
}

export interface LegacyGenerationParams {
  /** @deprecated Use `temperature`. */
  temp?: GenerationParams['temperature']
  /** @deprecated Use `topP`. */
  top_p?: GenerationParams['topP']
  /** @deprecated Use `topK`. */
  top_k?: GenerationParams['topK']
  /** @deprecated Use `frequencyPenalty`. */
  frequency_penalty?: GenerationParams['frequencyPenalty']
  /** @deprecated Use `presencePenalty`. */
  presence_penalty?: GenerationParams['presencePenalty']
  /** @deprecated Use `repeatPenalty`. */
  repeat_penalty?: GenerationParams['repeatPenalty']
  /** @deprecated Use `reasoningBudget`. */
  reasoning_budget?: GenerationParams['reasoningBudget']
  /** @deprecated Use `toolChoice`. */
  tool_choice?: GenerationParams['toolChoice']
  /** @deprecated Use `parallelToolCalls`. */
  parallel_tool_calls?: GenerationParams['parallelToolCalls']
}

type JsonSchemaResponseFormat = Extract<ResponseFormat, { type: 'json_schema' }>

export type LegacyJsonSchemaResponseFormat = Omit<JsonSchemaResponseFormat, 'jsonSchema'> & {
  /** @deprecated Use `jsonSchema`. */
  json_schema: JsonSchemaResponseFormat['jsonSchema']
}

export type WithLegacyCompletionParams<P> = Omit<P, 'generationParams' | 'responseFormat'> & {
  generationParams?:
    (NonNullable<P[Extract<keyof P, 'generationParams'>]> & LegacyGenerationParams) | undefined
  responseFormat?:
    P[Extract<keyof P, 'responseFormat'>] | LegacyJsonSchemaResponseFormat | undefined
}

export interface LegacyEmbedLlamacppConfig<C extends DecisionConfigInput | RerankConfigInput> {
  /** @deprecated Use `gpuLayers`. */
  gpu_layers?: C['gpuLayers']
  /** @deprecated Use `batchSize`. */
  batch_size?: C['batchSize']
  /** @deprecated Use `threadsBatch`. */
  'threads-batch'?: C['threadsBatch']
  /** @deprecated Use `flashAttention`. */
  flash_attn?: C['flashAttention']
  /** @deprecated Use `mainGpu`. */
  'main-gpu'?: C['mainGpu']
  /** @deprecated Use `splitMode`. */
  'split-mode'?: C['splitMode']
  /** @deprecated Use `tensorSplit`. */
  'tensor-split'?: C['tensorSplit']
}

type WhisperContextParams = NonNullable<WhisperConfig['contextParams']>
type WhisperVadParams = NonNullable<WhisperConfig['vadParams']>
type WhisperMiscConfig = NonNullable<WhisperConfig['miscConfig']>
type BciWhisperConfig = NonNullable<BciConfig['whisperConfig']>
type BciContextParams = NonNullable<BciConfig['contextParams']>

export interface LegacyWhisperContextParams {
  /** @deprecated Use `useGpu`. */
  use_gpu?: WhisperContextParams['useGpu']
  /** @deprecated Use `flashAttention`. */
  flash_attn?: WhisperContextParams['flashAttention']
  /** @deprecated Use `gpuDevice`. */
  gpu_device?: WhisperContextParams['gpuDevice']
  /** @deprecated Use `mainGpu`. */
  'main-gpu'?: WhisperContextParams['mainGpu']
}

export interface LegacyWhisperMiscConfig {
  /** @deprecated Use `captionEnabled`. */
  caption_enabled?: WhisperMiscConfig['captionEnabled']
}

export interface LegacyWhisperVadParams {
  /** @deprecated Use `minSpeechDurationMs`. */
  min_speech_duration_ms?: WhisperVadParams['minSpeechDurationMs']
  /** @deprecated Use `minSilenceDurationMs`. */
  min_silence_duration_ms?: WhisperVadParams['minSilenceDurationMs']
  /** @deprecated Use `maxSpeechDurationS`. */
  max_speech_duration_s?: WhisperVadParams['maxSpeechDurationS']
  /** @deprecated Use `speechPadMs`. */
  speech_pad_ms?: WhisperVadParams['speechPadMs']
  /** @deprecated Use `samplesOverlap`. */
  samples_overlap?: WhisperVadParams['samplesOverlap']
}

export interface LegacyWhisperDecodingConfig<C extends Partial<BciWhisperConfig>> {
  /** @deprecated Use `threads`. */
  n_threads?: C['threads']
  /** @deprecated Use `durationMs`. */
  duration_ms?: C['durationMs']
  /** @deprecated Use `noTimestamps`. */
  no_timestamps?: C['noTimestamps']
  /** @deprecated Use `singleSegment`. */
  single_segment?: C['singleSegment']
  /** @deprecated Use `printSpecial`. */
  print_special?: C['printSpecial']
  /** @deprecated Use `printProgress`. */
  print_progress?: C['printProgress']
  /** @deprecated Use `printRealtime`. */
  print_realtime?: C['printRealtime']
  /** @deprecated Use `printTimestamps`. */
  print_timestamps?: C['printTimestamps']
  /** @deprecated Use `detectLanguage`. */
  detect_language?: C['detectLanguage']
  /** @deprecated Use `suppressBlank`. */
  suppress_blank?: C['suppressBlank']
  /** @deprecated Use `suppressNst`. */
  suppress_nst?: C['suppressNst']
  /** @deprecated Use `greedyBestOf`. */
  greedy_best_of?: C['greedyBestOf']
  /** @deprecated Use `beamSize`. */
  beam_search_beam_size?: C['beamSize']
}

export interface LegacyWhisperConfig extends LegacyWhisperDecodingConfig<WhisperConfig> {
  /** @deprecated Use `nMaxTextCtx`. */
  n_max_text_ctx?: WhisperConfig['nMaxTextCtx']
  /** @deprecated Use `offsetMs`. */
  offset_ms?: WhisperConfig['offsetMs']
  /** @deprecated Use `audioCtx`. */
  audio_ctx?: WhisperConfig['audioCtx']
  /** @deprecated Use `noContext`. */
  no_context?: WhisperConfig['noContext']
  /** @deprecated Use `tokenTimestamps`. */
  token_timestamps?: WhisperConfig['tokenTimestamps']
  /** @deprecated Use `tholdPt`. */
  thold_pt?: WhisperConfig['tholdPt']
  /** @deprecated Use `tholdPtsum`. */
  thold_ptsum?: WhisperConfig['tholdPtsum']
  /** @deprecated Use `maxLen`. */
  max_len?: WhisperConfig['maxLen']
  /** @deprecated Use `splitOnWord`. */
  split_on_word?: WhisperConfig['splitOnWord']
  /** @deprecated Use `maxTokens`. */
  max_tokens?: WhisperConfig['maxTokens']
  /** @deprecated Use `debugMode`. */
  debug_mode?: WhisperConfig['debugMode']
  /** @deprecated Use `tdrzEnable`. */
  tdrz_enable?: WhisperConfig['tdrzEnable']
  /** @deprecated Use `suppressRegex`. */
  suppress_regex?: WhisperConfig['suppressRegex']
  /** @deprecated Use `initialPrompt`. */
  initial_prompt?: WhisperConfig['initialPrompt']
  /** @deprecated Use `carryInitialPrompt`. */
  carry_initial_prompt?: WhisperConfig['carryInitialPrompt']
  /** @deprecated Use `lengthPenalty`. */
  length_penalty?: WhisperConfig['lengthPenalty']
  /** @deprecated Use `temperatureInc`. */
  temperature_inc?: WhisperConfig['temperatureInc']
  /** @deprecated Use `entropyThold`. */
  entropy_thold?: WhisperConfig['entropyThold']
  /** @deprecated Use `logprobThold`. */
  logprob_thold?: WhisperConfig['logprobThold']
  /** @deprecated Use `maxInitialTs`. */
  max_initial_ts?: WhisperConfig['maxInitialTs']
  /** @deprecated Use `noSpeechThold`. */
  no_speech_thold?: WhisperConfig['noSpeechThold']
  /** @deprecated Use `vadParams`. */
  vad_params?: WhisperVadParams & LegacyWhisperVadParams
  /** @deprecated Use `audioFormat`. */
  audio_format?: WhisperConfig['audioFormat']
  vadParams?: WhisperVadParams & LegacyWhisperVadParams
  contextParams?: WhisperContextParams & LegacyWhisperContextParams
  miscConfig?: WhisperMiscConfig & LegacyWhisperMiscConfig
}

export interface LegacyBciConfig {
  whisperConfig?: BciWhisperConfig & LegacyWhisperDecodingConfig<BciWhisperConfig>
  bciConfig?: NonNullable<BciConfig['bciConfig']> & {
    /** @deprecated Use `dayIdx`. */
    day_idx?: NonNullable<BciConfig['bciConfig']>['dayIdx']
  }
  contextParams?: BciContextParams & Omit<LegacyWhisperContextParams, 'main-gpu'>
  miscConfig?: NonNullable<BciConfig['miscConfig']> & LegacyWhisperMiscConfig
}

type SdcppUpscalerConfig = NonNullable<SdcppConfig['upscaler']>

export interface LegacySdcppConfig {
  /** @deprecated Use `mainGpu`. */
  'main-gpu'?: SdcppConfig['mainGpu']
  /** @deprecated Use `samplerRng`. */
  sampler_rng?: SdcppConfig['samplerRng']
  /** @deprecated Use `vaeAutoCpuFallback`. */
  vae_auto_cpu_fallback?: SdcppConfig['vaeAutoCpuFallback']
  /** @deprecated Use `vaeAutoCpuFallbackMemoryRatio`. */
  vae_auto_cpu_fallback_memory_ratio?: SdcppConfig['vaeAutoCpuFallbackMemoryRatio']
  /** @deprecated Use `vaeTiling`. */
  vae_tiling?: SdcppConfig['vaeTiling']
  /** @deprecated Use `offloadToCpu`. */
  offload_to_cpu?: SdcppConfig['offloadToCpu']
  /** @deprecated Use `paramsBackend`. */
  params_backend?: SdcppConfig['paramsBackend']
  /** @deprecated Use `maxVram`. */
  max_vram?: SdcppConfig['maxVram']
  /** @deprecated Use `streamLayers`. */
  stream_layers?: SdcppConfig['streamLayers']
  /** @deprecated Use `flashAttention`. */
  flash_attn?: SdcppConfig['flashAttention']
  /** @deprecated Use `performanceProfile`. */
  performance_profile?: SdcppConfig['performanceProfile']
  /** @deprecated Use `performanceMaxWidth`. */
  performance_max_width?: SdcppConfig['performanceMaxWidth']
  /** @deprecated Use `performanceMaxHeight`. */
  performance_max_height?: SdcppConfig['performanceMaxHeight']
  /** @deprecated Use `performanceMaxFrames`. */
  performance_max_frames?: SdcppConfig['performanceMaxFrames']
  /** @deprecated Use `vaeConvDirect`. */
  vae_conv_direct?: SdcppConfig['vaeConvDirect']
  /** @deprecated Use `tensorTypeRules`. */
  tensor_type_rules?: SdcppConfig['tensorTypeRules']
  /** @deprecated Use `diffusionFlashAttention`. */
  diffusion_fa?: SdcppConfig['diffusionFlashAttention']
  /** @deprecated Use `loraApplyMode`. */
  lora_apply_mode?: SdcppConfig['loraApplyMode']
  upscaler?: SdcppUpscalerConfig & {
    /** @deprecated Use `modelSrc`. */
    model_src?: SdcppUpscalerConfig['modelSrc']
    /** @deprecated Use `tileSize`. */
    tile_size?: SdcppUpscalerConfig['tileSize']
    /** @deprecated Use `offloadToCpu`. */
    offload_params_to_cpu?: SdcppUpscalerConfig['offloadToCpu']
  }
}

interface LegacyImageGenerationParams<P extends DiffusionClientParams | VideoClientParams> {
  /** @deprecated Use `negativePrompt`. */
  negative_prompt?: P['negativePrompt']
  /** @deprecated Use `cfgScale`. */
  cfg_scale?: P['cfgScale']
  /** @deprecated Use `samplingMethod`. */
  sampling_method?: P['samplingMethod']
  /** @deprecated Use `vaeTiling`. */
  vae_tiling?: P['vaeTiling']
  /** @deprecated Use `vaeTileSize`. */
  vae_tile_size?: P['vaeTileSize']
  /** @deprecated Use `cachePreset`. */
  cache_preset?: P['cachePreset']
}

export type LegacyDiffusionClientParams = DiffusionClientParams &
  LegacyImageGenerationParams<DiffusionClientParams> & {
    /** @deprecated Use `imgCfgScale`. */
    img_cfg_scale?: DiffusionClientParams['imgCfgScale']
    /** @deprecated Use `customSigmas`. */
    custom_sigmas?: DiffusionClientParams['customSigmas']
    /** @deprecated Use `batchCount`. */
    batch_count?: DiffusionClientParams['batchCount']
    /** @deprecated Use `initImage`. */
    init_image?: Uint8Array
    /** @deprecated Use `initImages`. */
    init_images?: Uint8Array[]
    /** @deprecated Use `increaseRefIndex`. */
    increase_ref_index?: DiffusionClientParams['increaseRefIndex']
    /** @deprecated Use `autoResizeRefImage`. */
    auto_resize_ref_image?: DiffusionClientParams['autoResizeRefImage']
  }

interface LegacyVideoKeys extends LegacyImageGenerationParams<VideoClientParams> {
  /** @deprecated Use `loraStrength`. */
  lora_strength?: number
  /** @deprecated Use `stgScale`. */
  stg_scale?: VideoClientParams['stgScale']
  /** @deprecated Use `stgBlock`. */
  stg_block?: VideoClientParams['stgBlock']
  /** @deprecated Use `videoFrames`. */
  video_frames?: number
  /** @deprecated Use `flowShift`. */
  flow_shift?: VideoClientParams['flowShift']
  /** @deprecated Use `highNoiseSteps`. */
  high_noise_steps?: VideoClientParams['highNoiseSteps']
  /** @deprecated Use `highNoiseSampler`. */
  high_noise_sampler?: VideoClientParams['highNoiseSampler']
  /** @deprecated Use `highNoiseScheduler`. */
  high_noise_scheduler?: VideoClientParams['highNoiseScheduler']
  /** @deprecated Use `highNoiseCfgScale`. */
  high_noise_cfg_scale?: VideoClientParams['highNoiseCfgScale']
  /** @deprecated Use `highNoiseFlowShift`. */
  high_noise_flow_shift?: VideoClientParams['highNoiseFlowShift']
  /** @deprecated Use `moeBoundary`. */
  moe_boundary?: VideoClientParams['moeBoundary']
  /** @deprecated Use `vaceStrength`. */
  vace_strength?: VideoClientParams['vaceStrength']
  /** @deprecated Use `controlFrames`. */
  control_frames?: Uint8Array[]
  /** @deprecated Use `vaeTileOverlap`. */
  vae_tile_overlap?: VideoClientParams['vaeTileOverlap']
  /** @deprecated Use `temporalTiling`. */
  temporal_tiling?: VideoClientParams['temporalTiling']
  /** @deprecated Use `cacheMode`. */
  cache_mode?: VideoClientParams['cacheMode']
  /** @deprecated Use `cacheThreshold`. */
  cache_threshold?: VideoClientParams['cacheThreshold']
  /** @deprecated Use `referenceImages`. */
  reference_images?: readonly [Uint8Array]
  /** @deprecated Use `referenceAttentionStrength`. */
  reference_attention_strength?: number
  /** @deprecated Use `referenceDownscaleFactor`. */
  reference_downscale_factor?: 1
}

export type LegacyVideoClientParams = (
  | VideoClientParams
  | (Omit<VideoImg2vidClientParams, 'initImage'> & {
      /** @deprecated Use `initImage`. */
      init_image: Uint8Array
    })
) &
  LegacyVideoKeys

export type LegacyModelConfigs = {
  'llamacpp-completion': LegacyLlmConfig
  'llamacpp-decision': LegacyEmbedLlamacppConfig<DecisionConfigInput>
  'llamacpp-rerank': LegacyEmbedLlamacppConfig<RerankConfigInput>
  'whispercpp-transcription': LegacyWhisperConfig
  'bci-whispercpp-transcription': LegacyBciConfig
  'sdcpp-generation': LegacySdcppConfig
}

type CanonicalOf<T> = T extends keyof typeof ModelTypeAliases ? (typeof ModelTypeAliases)[T] : T

export type LegacyModelConfigOf<T> =
  CanonicalOf<T> extends keyof LegacyModelConfigs ? LegacyModelConfigs[CanonicalOf<T>] : unknown

export type WithLegacyModelConfig<O> = O extends { modelType: infer T; modelConfig?: infer C }
  ? Omit<O, 'modelConfig'> & { modelConfig?: C & LegacyModelConfigOf<T> }
  : O

export type LegacyKeySpec = {
  readonly renames?: Readonly<Record<string, string>>
  readonly nested?: Readonly<Record<string, LegacyKeySpec>>
}

/**
 * Receives each deprecated key's path, its replacement's path, and whether the
 * deprecated value was ignored because the replacement was also set.
 */
export type LegacyKeyWarn = (legacyPath: string, replacementPath: string, ignored?: boolean) => void

const LLM_CONFIG_KEYS: LegacyKeySpec = {
  renames: {
    ctx_size: 'ctxSize',
    temp: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
    gpu_layers: 'gpuLayers',
    system_prompt: 'systemPrompt',
    load_mode: 'loadMode',
    presence_penalty: 'presencePenalty',
    frequency_penalty: 'frequencyPenalty',
    repeat_penalty: 'repeatPenalty',
    stop_sequences: 'stopSequences',
    cache_checkpoints: 'cacheCheckpoints',
    cache_checkpoints_max_bytes: 'cacheCheckpointsMaxBytes',
    cache_checkpoint_storage: 'cacheCheckpointStorage',
    cache_checkpoint_dir: 'cacheCheckpointDir',
    cache_share_across_keys: 'cacheShareAcrossKeys',
    cache_ram_mib: 'cacheRamMib',
    'cache-type-k': 'cacheTypeK',
    'cache-type-v': 'cacheTypeV',
    'main-gpu': 'mainGpu',
    'rpc-servers': 'rpcServers',
    'split-mode': 'splitMode',
    'flash-attn': 'flashAttention',
    'tensor-split': 'tensorSplit',
    'batch-size': 'batchSize',
    'ubatch-size': 'ubatchSize',
    'cpu-moe': 'cpuMoe',
    'n-cpu-moe': 'nCpuMoe',
    'kv-offload': 'kvOffload',
    'image-max-tokens': 'imageMaxTokens',
    'image-min-tokens': 'imageMinTokens',
    'image-max-megapixels': 'imageMaxMegapixels',
    'threads-batch': 'threadsBatch',
    'cpu-mask': 'cpuMask',
    'cpu-mask-batch': 'cpuMaskBatch',
    'override-tensor': 'overrideTensor',
    'n-cpu-ffn': 'nCpuFfn',
    'moe-cache-mib': 'moeCacheMib',
    'prefetch-weights': 'prefetchWeights',
    'tensor-read-lazy': 'tensorReadLazy',
    'coreml-ffn': 'coremlFfn',
    'coreml-ffn-split': 'coremlFfnSplit',
    'coreml-ffn-cache': 'coremlFfnCache',
    'fit-target': 'fitTarget',
    'fit-ctx': 'fitCtx',
    reasoning_budget: 'reasoningBudget',
    spec_type: 'specType',
    spec_draft_n_max: 'specDraftNMax',
    spec_draft_n_min: 'specDraftNMin',
    spec_draft_p_min: 'specDraftPMin',
    image_tile_mode: 'imageTileMode',
    image_no_upscale: 'imageNoUpscale',
    'mmproj-use-gpu': 'mmprojUseGpu'
  }
}

const COMPLETION_PARAMS_KEYS: LegacyKeySpec = {
  nested: {
    generationParams: {
      renames: {
        temp: 'temperature',
        top_p: 'topP',
        top_k: 'topK',
        frequency_penalty: 'frequencyPenalty',
        presence_penalty: 'presencePenalty',
        repeat_penalty: 'repeatPenalty',
        reasoning_budget: 'reasoningBudget',
        tool_choice: 'toolChoice',
        parallel_tool_calls: 'parallelToolCalls'
      }
    },
    responseFormat: { renames: { json_schema: 'jsonSchema' } }
  }
}

const EMBED_LLAMACPP_CONFIG_KEYS: LegacyKeySpec = {
  renames: {
    gpu_layers: 'gpuLayers',
    batch_size: 'batchSize',
    'threads-batch': 'threadsBatch',
    flash_attn: 'flashAttention',
    'main-gpu': 'mainGpu',
    'split-mode': 'splitMode',
    'tensor-split': 'tensorSplit'
  }
}

const WHISPER_CONTEXT_PARAMS_KEYS: LegacyKeySpec = {
  renames: {
    use_gpu: 'useGpu',
    flash_attn: 'flashAttention',
    gpu_device: 'gpuDevice',
    'main-gpu': 'mainGpu'
  }
}

const WHISPER_MISC_CONFIG_KEYS: LegacyKeySpec = { renames: { caption_enabled: 'captionEnabled' } }

const WHISPER_DECODING_RENAMES = {
  n_threads: 'threads',
  duration_ms: 'durationMs',
  no_timestamps: 'noTimestamps',
  single_segment: 'singleSegment',
  print_special: 'printSpecial',
  print_progress: 'printProgress',
  print_realtime: 'printRealtime',
  print_timestamps: 'printTimestamps',
  detect_language: 'detectLanguage',
  suppress_blank: 'suppressBlank',
  suppress_nst: 'suppressNst',
  greedy_best_of: 'greedyBestOf',
  beam_search_beam_size: 'beamSize'
}

const WHISPER_CONFIG_KEYS: LegacyKeySpec = {
  renames: {
    ...WHISPER_DECODING_RENAMES,
    n_max_text_ctx: 'nMaxTextCtx',
    offset_ms: 'offsetMs',
    audio_ctx: 'audioCtx',
    no_context: 'noContext',
    token_timestamps: 'tokenTimestamps',
    thold_pt: 'tholdPt',
    thold_ptsum: 'tholdPtsum',
    max_len: 'maxLen',
    split_on_word: 'splitOnWord',
    max_tokens: 'maxTokens',
    debug_mode: 'debugMode',
    tdrz_enable: 'tdrzEnable',
    suppress_regex: 'suppressRegex',
    initial_prompt: 'initialPrompt',
    carry_initial_prompt: 'carryInitialPrompt',
    length_penalty: 'lengthPenalty',
    temperature_inc: 'temperatureInc',
    entropy_thold: 'entropyThold',
    logprob_thold: 'logprobThold',
    max_initial_ts: 'maxInitialTs',
    no_speech_thold: 'noSpeechThold',
    vad_params: 'vadParams',
    audio_format: 'audioFormat'
  },
  nested: {
    vadParams: {
      renames: {
        min_speech_duration_ms: 'minSpeechDurationMs',
        min_silence_duration_ms: 'minSilenceDurationMs',
        max_speech_duration_s: 'maxSpeechDurationS',
        speech_pad_ms: 'speechPadMs',
        samples_overlap: 'samplesOverlap'
      }
    },
    contextParams: WHISPER_CONTEXT_PARAMS_KEYS,
    miscConfig: WHISPER_MISC_CONFIG_KEYS
  }
}

const BCI_CONFIG_KEYS: LegacyKeySpec = {
  nested: {
    whisperConfig: { renames: WHISPER_DECODING_RENAMES },
    bciConfig: { renames: { day_idx: 'dayIdx' } },
    contextParams: WHISPER_CONTEXT_PARAMS_KEYS,
    miscConfig: WHISPER_MISC_CONFIG_KEYS
  }
}

const SDCPP_CONFIG_KEYS: LegacyKeySpec = {
  renames: {
    'main-gpu': 'mainGpu',
    sampler_rng: 'samplerRng',
    vae_auto_cpu_fallback: 'vaeAutoCpuFallback',
    vae_auto_cpu_fallback_memory_ratio: 'vaeAutoCpuFallbackMemoryRatio',
    vae_tiling: 'vaeTiling',
    offload_to_cpu: 'offloadToCpu',
    params_backend: 'paramsBackend',
    max_vram: 'maxVram',
    stream_layers: 'streamLayers',
    flash_attn: 'flashAttention',
    performance_profile: 'performanceProfile',
    performance_max_width: 'performanceMaxWidth',
    performance_max_height: 'performanceMaxHeight',
    performance_max_frames: 'performanceMaxFrames',
    vae_conv_direct: 'vaeConvDirect',
    tensor_type_rules: 'tensorTypeRules',
    diffusion_fa: 'diffusionFlashAttention',
    lora_apply_mode: 'loraApplyMode'
  },
  nested: {
    upscaler: {
      renames: {
        model_src: 'modelSrc',
        tile_size: 'tileSize',
        offload_params_to_cpu: 'offloadToCpu'
      }
    }
  }
}

const IMAGE_GENERATION_RENAMES = {
  negative_prompt: 'negativePrompt',
  cfg_scale: 'cfgScale',
  sampling_method: 'samplingMethod',
  vae_tiling: 'vaeTiling',
  vae_tile_size: 'vaeTileSize',
  cache_preset: 'cachePreset',
  init_image: 'initImage'
}

const DIFFUSION_PARAMS_KEYS: LegacyKeySpec = {
  renames: {
    ...IMAGE_GENERATION_RENAMES,
    img_cfg_scale: 'imgCfgScale',
    custom_sigmas: 'customSigmas',
    batch_count: 'batchCount',
    init_images: 'initImages',
    increase_ref_index: 'increaseRefIndex',
    auto_resize_ref_image: 'autoResizeRefImage'
  }
}

const VIDEO_PARAMS_KEYS: LegacyKeySpec = {
  renames: {
    ...IMAGE_GENERATION_RENAMES,
    lora_strength: 'loraStrength',
    stg_scale: 'stgScale',
    stg_block: 'stgBlock',
    video_frames: 'videoFrames',
    flow_shift: 'flowShift',
    high_noise_steps: 'highNoiseSteps',
    high_noise_sampler: 'highNoiseSampler',
    high_noise_scheduler: 'highNoiseScheduler',
    high_noise_cfg_scale: 'highNoiseCfgScale',
    high_noise_flow_shift: 'highNoiseFlowShift',
    moe_boundary: 'moeBoundary',
    vace_strength: 'vaceStrength',
    control_frames: 'controlFrames',
    vae_tile_overlap: 'vaeTileOverlap',
    temporal_tiling: 'temporalTiling',
    cache_mode: 'cacheMode',
    cache_threshold: 'cacheThreshold',
    reference_images: 'referenceImages',
    reference_attention_strength: 'referenceAttentionStrength',
    reference_downscale_factor: 'referenceDownscaleFactor'
  }
}

export const LEGACY_MODEL_CONFIG_KEYS: Partial<Record<CanonicalModelType, LegacyKeySpec>> = {
  'llamacpp-completion': LLM_CONFIG_KEYS,
  'llamacpp-decision': EMBED_LLAMACPP_CONFIG_KEYS,
  'llamacpp-rerank': EMBED_LLAMACPP_CONFIG_KEYS,
  'whispercpp-transcription': WHISPER_CONFIG_KEYS,
  'bci-whispercpp-transcription': BCI_CONFIG_KEYS,
  'sdcpp-generation': SDCPP_CONFIG_KEYS
}

export const LEGACY_REQUEST_KEYS: Readonly<Record<string, LegacyKeySpec>> = {
  completionStream: COMPLETION_PARAMS_KEYS,
  completionOrchestrate: COMPLETION_PARAMS_KEYS,
  batchCompletionStream: { nested: { prompts: COMPLETION_PARAMS_KEYS } },
  diffusionStream: DIFFUSION_PARAMS_KEYS,
  videoStream: VIDEO_PARAMS_KEYS
}

export function renameLegacyDiffusionParams(
  params: LegacyDiffusionClientParams,
  warn: LegacyKeyWarn
): DiffusionClientParams {
  return renameLegacyKeys(params, DIFFUSION_PARAMS_KEYS, warn) as DiffusionClientParams
}

export function renameLegacyVideoParams(
  params: LegacyVideoClientParams,
  warn: LegacyKeyWarn
): VideoClientParams {
  return renameLegacyKeys(params, VIDEO_PARAMS_KEYS, warn) as VideoClientParams
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(prefix: string, key: string) {
  return prefix === '' ? key : `${prefix}.${key}`
}

function renameObject(
  value: Record<string, unknown>,
  spec: LegacyKeySpec,
  warn: LegacyKeyWarn,
  path: string
): Record<string, unknown> {
  let result = value
  for (const [legacyKey, key] of Object.entries(spec.renames ?? {})) {
    if (!(legacyKey in result)) continue
    if (result === value) result = { ...value }
    const ignored = key in result
    if (!ignored) result[key] = result[legacyKey]
    delete result[legacyKey]
    warn(joinPath(path, legacyKey), joinPath(path, key), ignored)
  }
  for (const [key, childSpec] of Object.entries(spec.nested ?? {})) {
    const child = result[key]
    const renamed = renameLegacyKeys(child, childSpec, warn, joinPath(path, key))
    if (renamed === child) continue
    if (result === value) result = { ...value }
    result[key] = renamed
  }
  return result
}

export function renameLegacyKeys<T>(
  value: T,
  spec: LegacyKeySpec,
  warn: LegacyKeyWarn,
  path = ''
): T {
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map((item, index) => {
      const renamed = renameLegacyKeys(item, spec, warn, `${path}[${index}]`)
      if (renamed !== item) changed = true
      return renamed
    })
    return (changed ? items : value) as T
  }
  if (!isPlainObject(value)) return value
  return renameObject(value, spec, warn, path) as T
}

export type CamelCaseCompletionParams<P> = Omit<P, 'generationParams' | 'responseFormat'> & {
  generationParams?: GenerationParams | undefined
  responseFormat?: ResponseFormat | undefined
}

export function renameLegacyCompletionParams<P extends object>(
  params: P,
  warn: LegacyKeyWarn
): CamelCaseCompletionParams<P> {
  return renameLegacyKeys(params, COMPLETION_PARAMS_KEYS, warn) as CamelCaseCompletionParams<P>
}

export function renameLegacyModelConfigKeys<T>(
  modelType: unknown,
  modelConfig: T,
  warn: LegacyKeyWarn,
  path = 'modelConfig'
): T {
  if (typeof modelType !== 'string') return modelConfig
  const spec = LEGACY_MODEL_CONFIG_KEYS[normalizeModelType(modelType) as CanonicalModelType]
  return spec ? renameLegacyKeys(modelConfig, spec, warn, path) : modelConfig
}

function withPreviousKeys(value: unknown, spec: LegacyKeySpec): unknown {
  if (Array.isArray(value)) return value.map((item) => withPreviousKeys(item, spec))
  if (!isPlainObject(value)) return value
  const previous = new Map(Object.entries(spec.renames ?? {}).map(([legacy, key]) => [key, legacy]))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const childSpec = spec.nested?.[key]
      return [previous.get(key) ?? key, childSpec ? withPreviousKeys(item, childSpec) : item]
    })
  )
}

/**
 * The model config with each renamed key under its spelling before the
 * camelCase rename. Model ids and KV cache folders hash this form, so a load
 * keeps the id and the saved caches it had in earlier releases. It outlives the
 * deprecated keys: removing them must keep this mapping.
 */
export function modelConfigIdentity(
  modelType: string,
  modelConfig: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const spec = LEGACY_MODEL_CONFIG_KEYS[normalizeModelType(modelType) as CanonicalModelType]
  return spec
    ? (withPreviousKeys(modelConfig, spec) as Record<string, unknown> | undefined)
    : modelConfig
}

function renameLoadModelConfig<T extends Record<string, unknown>>(
  load: T,
  warn: LegacyKeyWarn,
  path: string
): T {
  if (!('modelConfig' in load)) return load
  const modelConfig = renameLegacyModelConfigKeys(
    load['modelType'] ?? inferModelTypeFromModelSrc(load['modelSrc']),
    load['modelConfig'],
    warn,
    joinPath(path, 'modelConfig')
  )
  return modelConfig === load['modelConfig'] ? load : { ...load, modelConfig }
}

export function renameLegacyRequestKeys<T>(request: T, warn: LegacyKeyWarn): T {
  if (!isPlainObject(request)) return request
  let result: Record<string, unknown> = request
  const type = result['type']

  if (type === 'loadModel') {
    result = renameLoadModelConfig(result, warn, '')
  } else if (type === 'assessModelFit' && Array.isArray(result['models'])) {
    const models = result['models'] as unknown[]
    const renamed = models.map((load, index) =>
      isPlainObject(load) ? renameLoadModelConfig(load, warn, `models[${index}]`) : load
    )
    if (renamed.some((load, index) => load !== models[index])) {
      result = { ...result, models: renamed }
    }
  }

  const spec = typeof type === 'string' ? LEGACY_REQUEST_KEYS[type] : undefined
  if (spec) result = renameLegacyKeys(result, spec, warn)
  return result as T
}

function renamePatternDefaults(
  defaults: Record<string, unknown>,
  warn: LegacyKeyWarn,
  path: string
): Record<string, unknown> {
  let result = defaults
  for (const [modelType, modelConfig] of Object.entries(defaults)) {
    const renamed = renameLegacyModelConfigKeys(
      modelType,
      modelConfig,
      warn,
      `${path}.${modelType}`
    )
    if (renamed === modelConfig) continue
    if (result === defaults) result = { ...defaults }
    result[modelType] = renamed
  }
  return result
}

export function renameLegacyConfigKeys<T>(config: T, warn: LegacyKeyWarn): T {
  if (!isPlainObject(config) || !Array.isArray(config['deviceDefaults'])) return config
  const patterns = config['deviceDefaults'] as unknown[]
  const renamed = patterns.map((pattern, index) => {
    if (!isPlainObject(pattern) || !isPlainObject(pattern['defaults'])) return pattern
    const defaults = renamePatternDefaults(
      pattern['defaults'],
      warn,
      `deviceDefaults[${index}].defaults`
    )
    return defaults === pattern['defaults'] ? pattern : { ...pattern, defaults }
  })
  const changed = renamed.some((pattern, index) => pattern !== patterns[index])
  return (changed ? { ...config, deviceDefaults: renamed } : config) as T
}

export function createLegacyKeyWarner(log: (message: string) => void): LegacyKeyWarn {
  const warned = new Set<string>()
  return (legacyPath, replacementPath, ignored = false) => {
    const pathWithoutIndexes = legacyPath.replace(/\[\d+\]/g, '[]')
    if (warned.has(pathWithoutIndexes)) return
    warned.add(pathWithoutIndexes)
    const deprecation = `"${legacyPath}" is deprecated and will be removed in the next release. Use "${replacementPath}" instead.`
    log(
      ignored
        ? `${deprecation} Its value was ignored because "${replacementPath}" is also set.`
        : deprecation
    )
  }
}

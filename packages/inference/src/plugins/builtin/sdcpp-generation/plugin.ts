import ImgStableDiffusion, {
  EsrganUpscaler,
  VideoStableDiffusion,
  type DiffusionFiles,
  type EsrganUpscalerConfig,
  type SdConfig,
  type VideoStableDiffusionArgs
} from '@qvac/diffusion-cpp'
import addonLogging from '@qvac/diffusion-cpp/addonLogging'
import type { WorldConfig } from '@qvac/diffusion-cpp/world'
import {
  definePlugin,
  defineHandler,
  sdcppConfigSchema,
  diffusionRequestSchema,
  diffusionStreamResponseSchema,
  videoRequestSchema,
  videoStreamResponseSchema,
  upscaleRequestSchema,
  upscaleStreamResponseSchema,
  worldSceneRequestSchema,
  worldSceneStreamResponseSchema,
  worldStepRequestSchema,
  worldStepStreamResponseSchema,
  ModelType,
  ADDON_DIFFUSION,
  type CreateModelParams,
  type PluginModelResult,
  type ResolveContext,
  type ResolveResult,
  type SdcppConfig
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { ModelLoadFailedError } from '@/errors/index'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'
import { diffusion } from '@/plugins/builtin/sdcpp-generation/ops/diffusion'
import {
  markLtxVideoModel,
  markMoeCapableVideoModel,
  video
} from '@/plugins/builtin/sdcpp-generation/ops/video'
import { upscale } from '@/plugins/builtin/sdcpp-generation/ops/upscale'
import {
  createWorldSession,
  worldCreateScene,
  worldScenePath,
  worldStep
} from '@/plugins/builtin/sdcpp-generation/ops/world'

type DiffusionArtifactKey =
  | 'clipLModelPath'
  | 'clipGModelPath'
  | 'clipVisionModelPath'
  | 't5XxlModelPath'
  | 'llmModelPath'
  | 'vaeModelPath'
  | 'highNoiseDiffusionModelPath'
  | 'uncondModelPath'
  | 'audioVaeModelPath'
  | 'embeddingsConnectorsModelPath'
  | 'esrganModelPath'
  | 'taehvModelPath'
  | 'seedScenePath'

// Single source of truth for `SdcppConfig.upscaler.*` → addon-config key
// mapping. Used by both the diffusion-mode (post-generation upscaler) and the
// standalone-upscale-mode branches; keeping the mapping in one place avoids
// drift if `@qvac/diffusion-cpp` ever adds or renames an `upscaler_*` key.
function flattenUpscalerKeys(upscaler: SdcppConfig['upscaler']): Partial<EsrganUpscalerConfig> {
  if (!upscaler) return {}
  return {
    ...(upscaler.tile_size !== undefined && {
      upscaler_tile_size: upscaler.tile_size
    }),
    ...(upscaler.direct !== undefined && {
      upscaler_direct: upscaler.direct
    }),
    ...(upscaler.offload_params_to_cpu !== undefined && {
      upscaler_offload_params_to_cpu: upscaler.offload_params_to_cpu
    }),
    ...(upscaler.threads !== undefined && {
      upscaler_threads: upscaler.threads
    })
  }
}

// `mode: "upscale"` builds an EsrganUpscaler directly (not via SdCtx), so the
// top-level `device` field has to be forwarded explicitly — it is not part of
// the `upscaler.*` block.
function toEsrganAddonConfig(config: SdcppConfig): EsrganUpscalerConfig {
  return {
    ...flattenUpscalerKeys(config.upscaler),
    ...(config.device !== undefined && { device: config.device }),
    ...(config.verbosity !== undefined && { verbosity: config.verbosity })
  }
}

/**
 * Stable-diffusion.cpp plugin for image diffusion, upscaling, and Wan video.
 *
 * Video mode is supported on React Native, but the QVAC-published Wan model
 * set is too large to load on typical mobile devices.
 */
export const diffusionPlugin = definePlugin({
  modelType: ModelType.sdcppGeneration,
  displayName: 'Image Generation & Upscaling (stable-diffusion.cpp)',
  addonPackage: ADDON_DIFFUSION,
  loadConfigSchema: sdcppConfigSchema,

  async resolveConfig(
    cfg: SdcppConfig,
    ctx: ResolveContext
  ): Promise<ResolveResult<SdcppConfig, DiffusionArtifactKey>> {
    if (cfg.uncondModelSrc && cfg.mode !== 'diffusion') {
      throw new ModelLoadFailedError(
        'modelConfig.uncondModelSrc is Ideogram 4 diffusion only. ' +
          "Use mode: 'diffusion' or remove uncondModelSrc."
      )
    }
    if (cfg.uncondModelSrc && (!cfg.llmModelSrc || !cfg.vaeModelSrc)) {
      throw new ModelLoadFailedError(
        'modelConfig.uncondModelSrc selects the Ideogram 4 layout and requires ' +
          'modelConfig.llmModelSrc (Qwen3-VL) and modelConfig.vaeModelSrc.'
      )
    }
    // A high-noise expert only has somewhere to go in the Wan 2.2 A14B video
    // layout: every other mode builds a model with no second-expert slot, and
    // embeddingsConnectorsModelSrc selects LTX-2 instead. Check it ahead of the
    // upscale early-return so a wrong layout fails loudly rather than
    // downloading a multi-gigabyte expert and dropping it in createModel.
    const isWan22MoeLayout = cfg.mode === 'video' && !cfg.embeddingsConnectorsModelSrc
    if (cfg.highNoiseDiffusionModelSrc && !isWan22MoeLayout) {
      throw new ModelLoadFailedError(
        'modelConfig.highNoiseDiffusionModelSrc selects the Wan 2.2 A14B ' +
          "mixture-of-experts video layout. It requires mode: 'video' and " +
          'cannot be combined with modelConfig.embeddingsConnectorsModelSrc ' +
          '(which selects the LTX-2 layout).'
      )
    }

    // ABot-World fields describe a walk session and have no meaning in any
    // other layout, so reject them up front rather than resolving files the
    // selected mode will drop.
    if (cfg.mode !== 'world') {
      const stray = (['taehvModelSrc', 'sceneSrc', 'world'] as const).find(
        (key) => cfg[key] !== undefined
      )
      if (stray) {
        throw new ModelLoadFailedError(
          `modelConfig.${stray} is ABot-World only. Use mode: 'world' or remove it.`
        )
      }
    } else {
      // The mirror of the rule above, as an ALLOW-list rather than a deny-list.
      // Only `config.world` and the four world artifact sources reach the walk
      // session; every other field the SCHEMA KNOWS is accepted by it and then
      // silently dropped.
      //
      // Scope worth being exact about: `sdcppConfigSchema` is not `.strict()`,
      // so a field it does not know — a typo'd `taehvModelSrcc`, say — is
      // stripped by Zod before this ever runs, and this list cannot see it.
      // That is whole-schema behaviour shared with every other mode, not
      // something world can change here. That splits into two kinds of harm, and a deny-list
      // would have to be extended by hand every time a diffusion or video field
      // is added:
      //   - compute keys such as `device: 'cpu'` — the escape hatch every other
      //     mode honours — hand back a GPU session with no feedback;
      //   - companion SOURCES such as `clipLModelSrc` are resolved below, which
      //     DOWNLOADS them, before createModel throws them away.
      const worldSupported = new Set([
        'mode',
        'taehvModelSrc',
        'sceneSrc',
        'world',
        't5XxlModelSrc',
        'vaeModelSrc'
      ])
      // Where world has a nested equivalent, name it — the rest just say so.
      const worldEquivalent: Record<string, string> = {
        device: 'world.backend',
        'main-gpu': 'world.backend',
        threads: 'world.threads',
        offload_to_cpu: 'world.offloadParamsToCpu'
      }
      const unsupported = Object.keys(cfg).filter(
        (key) => !worldSupported.has(key) && cfg[key as keyof typeof cfg] !== undefined
      )
      if (unsupported.length > 0) {
        const key = unsupported[0]!
        const pointer = worldEquivalent[key]
        throw new ModelLoadFailedError(
          `modelConfig.${key} does not reach the ABot-World session. ` +
            (pointer
              ? `Use modelConfig.${pointer} instead, which is forwarded to it.`
              : 'World mode accepts only taehvModelSrc, sceneSrc, t5XxlModelSrc, ' +
                'vaeModelSrc and the world block; nothing else reaches the walk ' +
                'session.') +
            (unsupported.length > 1 ? ` Also unsupported: ${unsupported.slice(1).join(', ')}.` : '')
        )
      }
      if (!cfg.taehvModelSrc) {
        throw new ModelLoadFailedError(
          'modelConfig.taehvModelSrc is required in world mode. Provide the taew2_2 ' +
            'pixel decoder before loading the walk session.'
        )
      }
      // A session that can neither walk an existing world nor build one is
      // inert; say so now rather than after downloading ~5.5 GB of DiT.
      if (!cfg.sceneSrc && (!cfg.t5XxlModelSrc || !cfg.vaeModelSrc)) {
        throw new ModelLoadFailedError(
          'World mode needs either modelConfig.sceneSrc (walk an existing world) or ' +
            'both modelConfig.t5XxlModelSrc (umT5-XXL) and modelConfig.vaeModelSrc ' +
            '(Wan2.2 VAE) so worldCreateScene can build one.'
        )
      }
    }

    // Standalone-upscaler mode never references auxiliary models: the primary
    // modelSrc IS the ESRGAN file. Skip resolution to avoid downloading
    // unused encoders/VAEs and to keep load fast.
    if (cfg.mode === 'upscale') {
      return { config: cfg }
    }

    const {
      clipLModelSrc,
      clipGModelSrc,
      clipVisionModelSrc,
      t5XxlModelSrc,
      llmModelSrc,
      vaeModelSrc,
      highNoiseDiffusionModelSrc,
      uncondModelSrc,
      audioVaeModelSrc,
      embeddingsConnectorsModelSrc,
      taehvModelSrc,
      sceneSrc,
      upscaler,
      ...rest
    } = cfg

    // audioVae / embeddingsConnectors are LTX-2 video companions. Reject them
    // up front — before any companion download — when the selected layout
    // can't consume them, instead of silently resolving the file and then
    // dropping it in createModel. Both fields are new, so this cannot break
    // existing callers.
    if (embeddingsConnectorsModelSrc && cfg.mode !== 'video') {
      throw new ModelLoadFailedError(
        'modelConfig.embeddingsConnectorsModelSrc selects the LTX-2 video ' +
          "layout and is only valid with mode: 'video'."
      )
    }
    if (audioVaeModelSrc && !(cfg.mode === 'video' && embeddingsConnectorsModelSrc)) {
      throw new ModelLoadFailedError(
        'modelConfig.audioVaeModelSrc is LTX-2 video only. It requires ' +
          "mode: 'video' together with modelConfig.embeddingsConnectorsModelSrc " +
          '(which selects the LTX-2 layout). Add embeddingsConnectorsModelSrc ' +
          'or remove audioVaeModelSrc.'
      )
    }

    // Video does not apply ESRGAN, so the whole `upscaler` object is dropped.
    // World does not either, but it REJECTS the field above rather than dropping
    // it silently, so it cannot reach here.
    const effectiveUpscaler = cfg.mode === 'video' ? undefined : upscaler
    const { model_src: esrganModelSrc, ...upscalerRuntime } = effectiveUpscaler ?? {}
    const runtimeConfig = {
      ...rest,
      ...(effectiveUpscaler && { upscaler: upscalerRuntime })
    } as SdcppConfig

    const sources = {
      clipLModelSrc,
      clipGModelSrc,
      clipVisionModelSrc,
      t5XxlModelSrc,
      llmModelSrc,
      vaeModelSrc,
      highNoiseDiffusionModelSrc,
      uncondModelSrc,
      audioVaeModelSrc,
      embeddingsConnectorsModelSrc,
      esrganModelSrc,
      taehvModelSrc,
      sceneSrc
    }
    const hasSources = Object.values(sources).some(Boolean)

    if (!hasSources) {
      return { config: runtimeConfig }
    }

    const resolve = ctx.resolveModelPath
    const [
      clipLModelPath,
      clipGModelPath,
      clipVisionModelPath,
      t5XxlModelPath,
      llmModelPath,
      vaeModelPath,
      highNoiseDiffusionModelPath,
      uncondModelPath,
      audioVaeModelPath,
      embeddingsConnectorsModelPath,
      esrganModelPath,
      taehvModelPath,
      seedScenePath
    ] = await Promise.all([
      clipLModelSrc ? resolve(clipLModelSrc) : undefined,
      clipGModelSrc ? resolve(clipGModelSrc) : undefined,
      clipVisionModelSrc ? resolve(clipVisionModelSrc) : undefined,
      t5XxlModelSrc ? resolve(t5XxlModelSrc) : undefined,
      llmModelSrc ? resolve(llmModelSrc) : undefined,
      vaeModelSrc ? resolve(vaeModelSrc) : undefined,
      highNoiseDiffusionModelSrc ? resolve(highNoiseDiffusionModelSrc) : undefined,
      uncondModelSrc ? resolve(uncondModelSrc) : undefined,
      audioVaeModelSrc ? resolve(audioVaeModelSrc) : undefined,
      embeddingsConnectorsModelSrc ? resolve(embeddingsConnectorsModelSrc) : undefined,
      esrganModelSrc ? resolve(esrganModelSrc) : undefined,
      taehvModelSrc ? resolve(taehvModelSrc) : undefined,
      sceneSrc ? resolve(sceneSrc) : undefined
    ])

    return {
      config: runtimeConfig,
      artifacts: {
        ...(clipLModelPath && { clipLModelPath }),
        ...(clipGModelPath && { clipGModelPath }),
        ...(clipVisionModelPath && { clipVisionModelPath }),
        ...(t5XxlModelPath && { t5XxlModelPath }),
        ...(llmModelPath && { llmModelPath }),
        ...(vaeModelPath && { vaeModelPath }),
        ...(highNoiseDiffusionModelPath && { highNoiseDiffusionModelPath }),
        ...(uncondModelPath && { uncondModelPath }),
        ...(audioVaeModelPath && { audioVaeModelPath }),
        ...(embeddingsConnectorsModelPath && { embeddingsConnectorsModelPath }),
        ...(esrganModelPath && { esrganModelPath }),
        ...(taehvModelPath && { taehvModelPath }),
        ...(seedScenePath && { seedScenePath })
      }
    }
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const { modelId, modelPath, modelConfig, artifacts } = params
    const config = (modelConfig ?? {}) as SdcppConfig

    // no multi-gpu on mobile
    if (isMobile()) {
      const stripped = stripMultiGpuKeys(config)
      if (stripped.length > 0) {
        getEngineLogger().warn(
          `[${ModelType.sdcppGeneration}:${modelId}] Multi-GPU parameters (${stripped.join(', ')}) are not supported on mobile (single-GPU device) — removing from config; model will load with single-GPU defaults`
        )
      }
    }

    // In diffusion mode the ESRGAN file (when post-generation upscale is
    // wanted) must come from upscaler.model_src — the primary modelPath is
    // the main diffusion checkpoint. Reject early with a clear error
    // instead of letting the native addon fail mid-load. Done before any
    // logger / native side-effects so callers can recover cleanly.
    if (
      config.mode === 'diffusion' &&
      config.upscaler !== undefined &&
      !artifacts?.['esrganModelPath']
    ) {
      throw new ModelLoadFailedError(
        'modelConfig.upscaler.model_src is required when modelConfig.upscaler ' +
          'is set in diffusion mode. Provide the ESRGAN model, omit the ' +
          "upscaler block, or switch to modelConfig.mode = 'upscale' to load " +
          'a standalone upscaler.'
      )
    }

    const logger = createStreamLogger(modelId, ModelType.sdcppGeneration)
    registerAddonLogger(modelId, ModelType.sdcppGeneration, logger)

    if (config.mode === 'upscale') {
      const model = new EsrganUpscaler({
        files: { esrgan: modelPath },
        config: toEsrganAddonConfig(config),
        logger,
        opts: { stats: true }
      })
      return { model }
    }

    if (config.mode === 'world') {
      if (!artifacts?.['taehvModelPath']) {
        throw new ModelLoadFailedError(
          'modelConfig.taehvModelSrc is required in world mode. ' +
            'Provide the taew2_2 pixel decoder before loading the walk session.'
        )
      }

      // Only the `world` block reaches the native session. The flat
      // stable-diffusion.cpp keys describe a sampler pipeline the walk session
      // does not have, and unknown keys are silently ignored natively — so
      // forwarding them would look supported and do nothing.
      const model = createWorldSession({
        modelId,
        files: {
          model: modelPath,
          taehv: artifacts['taehvModelPath'],
          scene: worldScenePath(modelId)
        },
        // Cast rather than rebuild: `exactOptionalPropertyTypes` will not widen
        // the schema's `x?: T` into the addon's `x?: T` without it, and the
        // addon already drops undefined values before stringifying them.
        config: (config.world ?? {}) as WorldConfig,
        encoders: {
          t5: artifacts['t5XxlModelPath'],
          vae: artifacts['vaeModelPath']
        },
        seedScenePath: artifacts['seedScenePath'],
        logger
      })
      return { model }
    }

    if (config.mode === 'video') {
      // Layout is selected the same way the addon self-detects it: the
      // presence of the LTX-2 text-embedding connectors switches from the
      // Wan layout (UMT5 via t5Xxl) to the LTX-2 layout (Gemma via llm +
      // video VAE + connectors, optional audio VAE). Mirrors
      // `SdModel::isLtxModel_ = !embeddingsConnectorsPath.empty()`.
      const embeddingsConnectorsModelPath = artifacts?.['embeddingsConnectorsModelPath']

      if (!artifacts?.['vaeModelPath']) {
        throw new ModelLoadFailedError(
          'modelConfig.vaeModelSrc is required in video mode. ' +
            'Provide the Wan or LTX-2 video VAE model before loading the video pipeline.'
        )
      }
      const vaeModelPath = artifacts['vaeModelPath']

      let files: VideoStableDiffusionArgs['files']
      if (embeddingsConnectorsModelPath) {
        if (!artifacts['llmModelPath']) {
          throw new ModelLoadFailedError(
            'modelConfig.llmModelSrc is required for LTX-2 video. ' +
              'Provide the Gemma text encoder model before loading the LTX-2 pipeline.'
          )
        }
        files = {
          model: modelPath,
          vae: vaeModelPath,
          llm: artifacts['llmModelPath'],
          embeddingsConnectors: embeddingsConnectorsModelPath,
          ...(artifacts['audioVaeModelPath'] && {
            audioVae: artifacts['audioVaeModelPath']
          }),
          ...(artifacts['esrganModelPath'] && { esrgan: artifacts['esrganModelPath'] })
        }
      } else {
        if (!artifacts['t5XxlModelPath']) {
          throw new ModelLoadFailedError(
            'modelConfig.t5XxlModelSrc is required in video mode. ' +
              'Provide the Wan text encoder model before loading the video pipeline.'
          )
        }
        files = {
          model: modelPath,
          vae: vaeModelPath,
          t5Xxl: artifacts['t5XxlModelPath'],
          ...(artifacts['highNoiseDiffusionModelPath'] && {
            highNoiseDiffusionModel: artifacts['highNoiseDiffusionModelPath']
          }),
          ...(artifacts['clipVisionModelPath'] && {
            clipVision: artifacts['clipVisionModelPath']
          }),
          ...(artifacts['esrganModelPath'] && { esrgan: artifacts['esrganModelPath'] })
        }
      }

      /* eslint-disable @typescript-eslint/no-unused-vars */
      const {
        clipLModelSrc,
        clipGModelSrc,
        clipVisionModelSrc,
        t5XxlModelSrc,
        llmModelSrc,
        vaeModelSrc,
        highNoiseDiffusionModelSrc,
        uncondModelSrc,
        audioVaeModelSrc,
        embeddingsConnectorsModelSrc,
        upscaler,
        mode,
        ...rest
      } = config
      /* eslint-enable @typescript-eslint/no-unused-vars */

      const model = new VideoStableDiffusion({
        files,
        config: rest as SdConfig,
        logger,
        opts: { stats: true }
      })
      if (embeddingsConnectorsModelPath) markLtxVideoModel(model)
      if (files.highNoiseDiffusionModel) markMoeCapableVideoModel(model)
      return { model }
    }

    const files: DiffusionFiles = {
      model: modelPath,
      ...(artifacts?.['clipLModelPath'] && { clipL: artifacts['clipLModelPath'] }),
      ...(artifacts?.['clipGModelPath'] && { clipG: artifacts['clipGModelPath'] }),
      ...(artifacts?.['t5XxlModelPath'] && { t5Xxl: artifacts['t5XxlModelPath'] }),
      ...(artifacts?.['llmModelPath'] && { llm: artifacts['llmModelPath'] }),
      ...(artifacts?.['vaeModelPath'] && { vae: artifacts['vaeModelPath'] }),
      ...(artifacts?.['uncondModelPath'] && {
        uncondModel: artifacts['uncondModelPath']
      }),
      ...(artifacts?.['esrganModelPath'] && { esrgan: artifacts['esrganModelPath'] })
    }

    // `mode` is consumed by this plugin to select the model class above; the
    // stable-diffusion.cpp native config does not understand it. Strip it
    // before forwarding `rest` to the addon.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { upscaler, mode, ...rest } = config
    const addonConfig = {
      ...rest,
      ...flattenUpscalerKeys(upscaler)
    } as SdConfig

    const model = new ImgStableDiffusion({
      files,
      config: addonConfig,
      logger,
      opts: { stats: true }
    })

    return { model }
  },

  handlers: {
    diffusionStream: defineHandler({
      requestSchema: diffusionRequestSchema,
      responseSchema: diffusionStreamResponseSchema,
      streaming: true,
      // sdcpp diffusion exposes a model-wide hard cancel — compute
      // is interrupted on the currently-running generation.
      cancel: { scope: 'model', hard: true },
      handler: diffusion
    }),
    videoStream: defineHandler({
      requestSchema: videoRequestSchema,
      responseSchema: videoStreamResponseSchema,
      streaming: true,
      cancel: { scope: 'model', hard: true },
      handler: video
    }),
    upscaleStream: defineHandler({
      requestSchema: upscaleRequestSchema,
      responseSchema: upscaleStreamResponseSchema,
      streaming: true,
      // sdcpp upscale path has no cancel surface today — we fall
      // back to soft-cancel.
      cancel: { scope: 'none' },
      handler: upscale
    }),
    worldStepStream: defineHandler({
      requestSchema: worldStepRequestSchema,
      responseSchema: worldStepStreamResponseSchema,
      streaming: true,
      // Block-granular, not mid-block: the engine has no abort hook, so the
      // current block finishes internally. Cancel stops frame delivery and
      // makes the step reject rather than resolve truncated, so it is a real
      // cancel from the caller's side — it just does not shorten the compute.
      cancel: { scope: 'model', hard: false },
      handler: worldStep
    }),
    worldSceneStream: defineHandler({
      requestSchema: worldSceneRequestSchema,
      responseSchema: worldSceneStreamResponseSchema,
      streaming: true,
      // Scene creation is uninterruptible — the engine accepts no abort
      // predicate for it, so the SDK falls back to soft-cancel.
      cancel: { scope: 'none' },
      handler: worldCreateScene
    })
  },

  logging: {
    module: addonLogging,
    namespace: ModelType.sdcppGeneration
  }
})

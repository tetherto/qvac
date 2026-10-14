import type { FitProbeRequest, FitProbeResult } from '@/resources/model-fit/native-probe/engine-fit'

/**
 * Loads the one addon a probe names and asks it for a projection. The child
 * registers no plugins, so the fitter cannot come off the registry here. Only
 * the child reaches this module, and the supervisor spawns it by path rather
 * than importing it, so these specifiers stay out of the graph a host bundles.
 */
async function assessFitOf(probe: FitProbeRequest): Promise<unknown> {
  switch (probe.engine) {
    case 'llm-llamacpp': {
      const { default: LlmLlamacpp } = await import('@qvac/llm-llamacpp')
      return LlmLlamacpp.assessFit(probe.request)
    }
    case 'embed-llamacpp': {
      const { assessFit } = await import('@qvac/embed-llamacpp')
      return assessFit(probe.request)
    }
    case 'asr-ggml': {
      const { default: ASRGgml } = await import('@qvac/asr-ggml')
      return ASRGgml.assessFit(probe.request)
    }
    case 'bci-whispercpp': {
      const { assessFit } = await import('@qvac/bci-whispercpp')
      return assessFit(probe.request)
    }
    case 'tts-ggml': {
      const { default: TTSGgml } = await import('@qvac/tts-ggml')
      return TTSGgml.assessFit(probe.request)
    }
    case 'audiogen-ggml': {
      const { assessFit } = await import('@qvac/audiogen-ggml')
      return assessFit(probe.request)
    }
    case 'diffusion-cpp': {
      const { assessFit } = await import('@qvac/diffusion-cpp')
      return assessFit(probe.request)
    }
  }
}

export async function callChildEngineFit(probe: FitProbeRequest): Promise<FitProbeResult> {
  return { engine: probe.engine, result: await assessFitOf(probe) } as FitProbeResult
}

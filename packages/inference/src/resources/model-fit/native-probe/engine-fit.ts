import type { AsrFitRequest, AsrFitResult } from '@qvac/asr-ggml'
import type { AudiogenFitRequest, AudiogenFitResult } from '@qvac/audiogen-ggml'
import type { BciFitRequest, BciFitResult } from '@qvac/bci-whispercpp'
import type { DiffusionFitRequest, DiffusionFitResult } from '@qvac/diffusion-cpp'
import type { EmbedFitRequest, EmbedFitResult } from '@qvac/embed-llamacpp'
import type LlmLlamacpp from '@qvac/llm-llamacpp'
import type { TtsFitRequest, TtsFitResult } from '@qvac/tts-ggml'

/**
 * The engine packages each expose their own `assessFit`, taking the same fields
 * their loader takes and returning the figures their fitter measures. Every
 * member is plain JSON, so a request can cross a process boundary unchanged.
 */
export type FitProbeRequest =
  | { engine: 'llm-llamacpp'; request: LlmLlamacpp.FitRequest }
  | { engine: 'embed-llamacpp'; request: EmbedFitRequest }
  | { engine: 'asr-ggml'; request: AsrFitRequest }
  | { engine: 'bci-whispercpp'; request: BciFitRequest }
  | { engine: 'tts-ggml'; request: TtsFitRequest }
  | { engine: 'audiogen-ggml'; request: AudiogenFitRequest }
  | { engine: 'diffusion-cpp'; request: DiffusionFitRequest }

export type FitProbeEngine = FitProbeRequest['engine']

export type FitProbeResult =
  | { engine: 'llm-llamacpp'; result: LlmLlamacpp.FitResult }
  | { engine: 'embed-llamacpp'; result: EmbedFitResult }
  | { engine: 'asr-ggml'; result: AsrFitResult }
  | { engine: 'bci-whispercpp'; result: BciFitResult }
  | { engine: 'tts-ggml'; result: TtsFitResult }
  | { engine: 'audiogen-ggml'; result: AudiogenFitResult }
  | { engine: 'diffusion-cpp'; result: DiffusionFitResult }

/** Calls one engine's fitter, taken from the plugin that owns its addon. */
export async function callEngineFit(probe: FitProbeRequest): Promise<FitProbeResult> {
  const { getAllPlugins } = await import('@/plugins/registry')
  const addonPackage = `@qvac/${probe.engine}`
  const plugin = getAllPlugins().find((candidate) => candidate.addonPackage === addonPackage)

  if (plugin?.assessFit === undefined) {
    throw new TypeError(`no registered plugin exposes assessFit for ${addonPackage}`)
  }

  return {
    engine: probe.engine,
    result: plugin.assessFit(probe.request as never)
  } as FitProbeResult
}

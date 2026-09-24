import type { AsrFitRequest, AsrFitResult } from '@qvac/asr-ggml'
import type { AudiogenFitRequest, AudiogenFitResult } from '@qvac/audiogen-ggml'
import type { BciFitRequest, BciFitResult } from '@qvac/bci-whispercpp'
import type { DiffusionFitRequest, DiffusionFitResult } from '@qvac/diffusion-cpp'
import type { EmbedFitRequest, EmbedFitResult } from '@qvac/embed-llamacpp'
import type LlmLlamacpp from '@qvac/llm-llamacpp'
import type { TtsFitRequest, TtsFitResult } from '@qvac/tts-ggml'

/**
 * The engine packages each expose their own `assessFit`, taking the same fields
 * their loader takes and returning the figures their fitter measures. This
 * union is the one place the SDK names all seven, and every member is plain
 * JSON so a request can cross a process boundary unchanged.
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

/**
 * Calls one engine's fitter. The import is dynamic and reached only for the
 * engine being probed, so a host that ships a single engine never resolves the
 * other six, and no addon is loaded by the act of asking for a projection.
 */
type AssessFit = (request: never) => FitProbeResult['result']

/**
 * Most engine packages assign `module.exports` wholesale, so an ESM importer
 * may see only `default`. The export is read off whichever of the two the
 * package actually presents.
 */
export function assessFitOf(mod: unknown): AssessFit {
  const ns = mod as { assessFit?: AssessFit; default?: { assessFit?: AssessFit } }
  const fit = ns.assessFit ?? ns.default?.assessFit
  if (fit === undefined) throw new TypeError('engine package exposes no assessFit')
  return fit
}

export async function callEngineFit(probe: FitProbeRequest): Promise<FitProbeResult> {
  const mod = await importEngine(probe.engine)
  return {
    engine: probe.engine,
    result: assessFitOf(mod)(probe.request as never)
  } as FitProbeResult
}

function importEngine(engine: FitProbeEngine): Promise<unknown> {
  switch (engine) {
    case 'llm-llamacpp':
      return import('@qvac/llm-llamacpp')
    case 'embed-llamacpp':
      return import('@qvac/embed-llamacpp')
    case 'asr-ggml':
      return import('@qvac/asr-ggml')
    case 'bci-whispercpp':
      return import('@qvac/bci-whispercpp')
    case 'tts-ggml':
      return import('@qvac/tts-ggml')
    case 'audiogen-ggml':
      return import('@qvac/audiogen-ggml')
    case 'diffusion-cpp':
      return import('@qvac/diffusion-cpp')
  }
}

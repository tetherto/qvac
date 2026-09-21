import { ModelLoadFailedError } from '@/errors/index'
import {
  audioGenConfigSchema,
  type AcestepAudioGenConfig,
  type MinimaxAudioGenConfig,
  type ResolveContext
} from '@/schemas/index'

export async function resolveAudioGenConfig(config: Record<string, unknown>, ctx: ResolveContext) {
  const parsed = audioGenConfigSchema.parse(config)
  return parsed.engine === 'minimax'
    ? resolveMinimaxConfig(parsed, ctx)
    : resolveAcestepConfig(parsed, ctx)
}

async function resolveMinimaxConfig(parsed: MinimaxAudioGenConfig, ctx: ResolveContext) {
  if (ctx.platform === 'android' || ctx.platform === 'ios') {
    throw new ModelLoadFailedError('MiniMax-Music3 is available on desktop only')
  }

  const { lmModelSrc, synthModelSrc, ...runtimeConfig } = parsed
  // Resolve sequentially for the same stall-timeout reason documented for the
  // larger ACE-Step artifact set below.
  const lmModelPath = await ctx.resolveModelPath(lmModelSrc)
  const synthModelPath = await ctx.resolveModelPath(synthModelSrc)

  return {
    config: runtimeConfig,
    artifacts: {
      lmModelPath,
      synthModelPath
    }
  }
}

async function resolveAcestepConfig(parsed: AcestepAudioGenConfig, ctx: ResolveContext) {
  const { textEncModelSrc, lmModelSrc, ditModelSrc, vaeModelSrc, ...runtimeConfig } = parsed
  // These four artifacts total several gigabytes. Resolving them concurrently
  // splits bandwidth across independent registry streams and can make each one
  // exceed the per-block stall timeout even while aggregate throughput is
  // healthy. Resolve sequentially until model constants and config resolution
  // can expose a companion set together with all four resolved artifact paths.
  const textEncModelPath = await ctx.resolveModelPath(textEncModelSrc)
  const lmModelPath = await ctx.resolveModelPath(lmModelSrc)
  const ditModelPath = await ctx.resolveModelPath(ditModelSrc)
  const vaeModelPath = await ctx.resolveModelPath(vaeModelSrc)

  return {
    config: runtimeConfig,
    artifacts: {
      textEncModelPath,
      lmModelPath,
      ditModelPath,
      vaeModelPath
    }
  }
}

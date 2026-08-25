import { audioGenConfigSchema, type ResolveContext } from '@/schemas/index'

export async function resolveAudioGenConfig(config: Record<string, unknown>, ctx: ResolveContext) {
  const parsed = audioGenConfigSchema.parse(config)
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

import { audioGenConfigSchema, type ResolveContext } from '@/schemas'

export async function resolveAudioGenConfig(config: Record<string, unknown>, ctx: ResolveContext) {
  const parsed = audioGenConfigSchema.parse(config)
  const { textEncModelSrc, lmModelSrc, ditModelSrc, vaeModelSrc, ...runtimeConfig } = parsed
  const [textEncModelPath, lmModelPath, ditModelPath, vaeModelPath] = await Promise.all([
    ctx.resolveModelPath(textEncModelSrc),
    ctx.resolveModelPath(lmModelSrc),
    ctx.resolveModelPath(ditModelSrc),
    ctx.resolveModelPath(vaeModelSrc)
  ])

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

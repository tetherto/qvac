import type { BciConfig, ResolveContext } from "@/schemas";

export async function resolveBciConfig(cfg: BciConfig, ctx: ResolveContext) {
  const { embedderModelSrc, ...bciConfig } = cfg;

  if (!embedderModelSrc) {
    return { config: bciConfig };
  }

  const embedderPath = await ctx.resolveModelPath(embedderModelSrc);
  return {
    config: bciConfig,
    artifacts: { embedderPath },
  };
}

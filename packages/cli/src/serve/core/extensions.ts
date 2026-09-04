import type { FastifyInstance } from 'fastify'
import type { QvacContext } from '@/serve/core/context'

/**
 * One mountable API surface. Core knows this shape and nothing else about any
 * extension; the registry of concrete extensions lives in `serve/extensions`.
 */
export interface ServeExtension {
  /** Also the `serve.<name>` config key and the `--<name>` CLI flag. */
  name: string
  /** Shown in CLI help and in the composed OpenAPI description. */
  description: string
  /** Swagger tag name to description, merged into the document. */
  tags?: Record<string, string>
  /**
   * Request field to error code, or `field:<zod issue code>` to give one
   * validation failure its own code. One error handler serves every route, so
   * these share a namespace across extensions: two extensions mapping the same
   * key to different codes is refused at startup.
   */
  errorCodes?: Record<string, string>
  /** Parses this extension's `serve.<name>` config block. */
  parseConfig?(raw: unknown): unknown
  /** Builds the state this extension's routes read, before any route is mounted. */
  setup?(ctx: QvacContext, options: unknown): Promise<unknown>
  register(app: FastifyInstance): Promise<void>
  /** Startup warnings, logged once the server is ready. */
  banners?(state: unknown): string[]
}

export function extensionSummary(extensions: readonly ServeExtension[]): string {
  if (extensions.length === 0) return 'No surfaces are mounted.'
  const mounted = extensions.map((e) => `${e.name} (${e.description})`).join(', ')
  return `Mounted surfaces: ${mounted}.`
}

export function extensionErrorCodes(extensions: readonly ServeExtension[]): Record<string, string> {
  const codes: Record<string, string> = {}
  const owners: Record<string, string> = {}

  for (const extension of extensions) {
    for (const [field, code] of Object.entries(extension.errorCodes ?? {})) {
      const claimed = codes[field]
      if (claimed !== undefined && claimed !== code) {
        throw new Error(
          `Serve extensions "${owners[field]}" and "${extension.name}" both map the "${field}" ` +
            `request field, to "${claimed}" and "${code}". Rename one field or agree on one code.`
        )
      }
      codes[field] = code
      owners[field] = extension.name
    }
  }

  return codes
}

export function extensionTags(
  extensions: readonly ServeExtension[]
): Array<{ name: string; description: string }> {
  return extensions.flatMap((extension) =>
    Object.entries(extension.tags ?? {}).map(([name, description]) => ({ name, description }))
  )
}

// Populates `ctx.extensions` before any route runs, so a route can rely on its
// own slot being present.
export async function setupExtensions(
  ctx: QvacContext,
  extensions: readonly ServeExtension[],
  options: Record<string, unknown>
): Promise<void> {
  const slots = ctx.extensions as Record<string, unknown>
  for (const extension of extensions) {
    if (extension.setup === undefined) continue
    slots[extension.name] = await extension.setup(ctx, options[extension.name])
  }
}

export function extensionBanners(
  ctx: QvacContext,
  extensions: readonly ServeExtension[]
): string[] {
  const slots = ctx.extensions as Record<string, unknown>
  return extensions.flatMap((extension) => extension.banners?.(slots[extension.name]) ?? [])
}

// Each extension gets its own Fastify scope, so its hooks, body limits and
// content-type parsers stay local to its routes.
export async function mountExtensions(
  app: FastifyInstance,
  extensions: readonly ServeExtension[]
): Promise<void> {
  for (const extension of extensions) {
    await app.register(async (scope) => {
      await extension.register(scope)
    })
  }
}

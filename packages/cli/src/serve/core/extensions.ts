import type { FastifyInstance } from 'fastify'

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
  register(app: FastifyInstance): Promise<void>
}

export function extensionTags(
  extensions: readonly ServeExtension[]
): Array<{ name: string; description: string }> {
  return extensions.flatMap((extension) =>
    Object.entries(extension.tags ?? {}).map(([name, description]) => ({ name, description }))
  )
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

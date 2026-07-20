import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildServer } from '../serve/index.js'

export type SpecFormat = 'json' | 'yaml'

export interface EmitOpenApiSpecOptions {
  output?: string | undefined
  format?: SpecFormat | undefined
}

/**
 * Build the server in-process (no listen), capture the OpenAPI doc, and
 * return it as a string. The `quiet: true` flag on `buildServer` keeps the
 * logger silent so this never contaminates stdout / stderr for callers.
 */
export async function renderOpenApiSpec(format: SpecFormat = 'json'): Promise<string> {
  const app = await buildServer({
    projectRoot: tmpdir(),
    port: 0,
    host: '127.0.0.1',
    quiet: true
  })
  try {
    await app.ready()
    const spec = app.swagger() as Record<string, unknown>
    if (format === 'yaml') {
      const { dump } = await import('js-yaml')
      return dump(spec, { lineWidth: 100 })
    }
    return JSON.stringify(spec, null, 2) + '\n'
  } finally {
    await app.close()
  }
}

export async function emitOpenApiSpec(opts: EmitOpenApiSpecOptions = {}): Promise<void> {
  const text = await renderOpenApiSpec(opts.format ?? 'json')
  if (opts.output) {
    writeFileSync(opts.output, text)
  } else {
    process.stdout.write(text)
  }
}

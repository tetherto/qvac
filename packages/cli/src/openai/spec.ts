import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { buildServer } from '../serve/index.js'

export interface EmitOpenApiSpecOptions {
  output?: string | undefined
  format?: 'json' | 'yaml' | undefined
}

export async function emitOpenApiSpec (opts: EmitOpenApiSpecOptions = {}): Promise<void> {
  const app = await buildServer({
    projectRoot: tmpdir(),
    port: 0,
    host: '127.0.0.1',
    quiet: true
  })
  try {
    await app.ready()
    const spec = app.swagger() as Record<string, unknown>

    let text: string
    if (opts.format === 'yaml') {
      const { dump } = await import('js-yaml')
      text = dump(spec, { lineWidth: 100 })
    } else {
      text = JSON.stringify(spec, null, 2) + '\n'
    }

    if (opts.output) {
      writeFileSync(opts.output, text)
    } else {
      process.stdout.write(text)
    }
  } finally {
    await app.close()
  }
}

import fs from 'fs'

interface Handler {
  name: string
  request: { name: string; stream?: boolean }
  response: { name: string; stream?: boolean }
}

interface Builder {
  handlers: ReadonlyArray<Handler>
}

const header = '// Generated from schema/sync.ts. Do not edit.\n\n'

function camel(name: string, prefix = '') {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const parts = base.split(/[/-]/)
  return (
    prefix +
    parts
      .map((part, index) =>
        index === 0 && prefix.length === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
      )
      .join('')
  )
}

function typeName(name: string) {
  return name
    .slice(1)
    .split(/[/-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

export function writeBoundary(builder: Builder, directory: string) {
  let bind = `${header}import { pipeline, Readable } from 'streamx'\n\nfunction noop() {}\n\nexport function bindApi(rpc, api) {\n`
  let calls = `${header}function noop() {}\n\nfunction armed(stream) {\n  stream.on('error', noop)\n  return stream\n}\n\nexport function createCalls(rpc) {\n  return {\n`
  let capabilities = `${header}import type * as T from './hyperschema/types.d.ts'\n\nexport interface WatchStream<T> extends AsyncIterable<T> {\n  on(event: 'data', listener: (value: T) => void): this\n  on(event: 'error', listener: (error: Error) => void): this\n  destroy(): void\n}\n\nexport interface Capabilities {\n`
  let handlers = 'export interface CapabilityHandlers {\n'

  for (const handler of builder.handlers) {
    const method = camel(handler.name)
    const onMethod = camel(handler.name, 'on')
    const request = `T.${typeName(handler.request.name)}`
    const response = `T.${typeName(handler.response.name)}`
    const optional = handler.request.name === '@rpc/empty' ? '?' : ''

    if (handler.response.stream) {
      bind += `  if (api.${method}) rpc.${onMethod}((out) => {\n`
      bind += `    const source = Readable.from(api.${method}(out.data))\n`
      bind += `    source.on('error', (error) => out.writeStream?.destroy(error))\n`
      bind += `    pipeline(source, out, noop)\n`
      bind += `    out.writeStream?.on('close', () => source.destroy())\n`
      bind += '  })\n'
      calls += `    ${method}: (input) => armed(rpc.${method}(input)),\n`
      capabilities += `  ${method}(input${optional}: ${request}): WatchStream<${response}>\n`
      handlers += `  ${method}(input: ${request}): AsyncIterable<${response}>\n`
    } else {
      bind += `  if (api.${method}) rpc.${onMethod}((input) => api.${method}(input))\n`
      calls += `    ${method}: (input) => rpc.${method}(input),\n`
      capabilities += `  ${method}(input${optional}: ${request}): Promise<${response}>\n`
      handlers += `  ${method}(input: ${request}): ${response} | Promise<${response}>\n`
    }
  }

  bind += '}\n'
  calls += '  }\n}\n'
  capabilities += '}\n\n'
  handlers += '}\n'
  fs.writeFileSync(`${directory}/bind.js`, bind)
  fs.writeFileSync(`${directory}/calls.js`, calls)
  fs.writeFileSync(`${directory}/capabilities.d.ts`, capabilities + handlers)
}

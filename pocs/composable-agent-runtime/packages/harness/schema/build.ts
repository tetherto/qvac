import fs from 'bare-fs'
import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import HRPCBuilder from 'hrpc'
import Hyperschema from 'hyperschema'
import {
  harnessApi,
  registerHarnessApi,
  registerHarnessTypes
} from './harness.ts'
import {
  registerToolSandboxApi,
  registerToolSandboxTypes
} from './tool-sandbox.ts'

const directory = path.dirname(fileURLToPath(import.meta.url))
const specDirectory = path.join(directory, '..', 'spec')
const schemaDirectory = path.join(specDirectory, 'hyperschema')
const hrpcDirectory = path.join(specDirectory, 'hrpc')

const schema = Hyperschema.from(schemaDirectory)
registerHarnessTypes(schema.namespace('harness'))
Hyperschema.toDisk(schema, { esm: true })

const builder = HRPCBuilder.from(schemaDirectory, hrpcDirectory)
registerHarnessApi(builder.namespace('harness'))
HRPCBuilder.toDisk(builder)
fs.writeFileSync(
  path.join(hrpcDirectory, 'index.d.ts'),
  generateHarnessDeclarations()
)

const toolSandboxDirectory = path.join(specDirectory, 'tool-sandbox')
const toolSandboxSchemaDirectory = path.join(toolSandboxDirectory, 'hyperschema')
const toolSandboxHrpcDirectory = path.join(toolSandboxDirectory, 'hrpc')
const toolSandboxSchema = Hyperschema.from(toolSandboxSchemaDirectory)
registerToolSandboxTypes(toolSandboxSchema.namespace('tool-sandbox'))
Hyperschema.toDisk(toolSandboxSchema, { esm: true })

const toolSandboxBuilder = HRPCBuilder.from(
  toolSandboxSchemaDirectory,
  toolSandboxHrpcDirectory
)
registerToolSandboxApi(toolSandboxBuilder.namespace('tool-sandbox'))
HRPCBuilder.toDisk(toolSandboxBuilder)

function generateHarnessDeclarations() {
  const methods = harnessApi.flatMap(({ name, request }) => {
    const methodName = camelCase(name)
    const handlerName = `on${methodName[0]?.toUpperCase()}${methodName.slice(1)}`
    if (request.stream) {
      return [
        `  ${methodName}(input?: Record<string, WireValue>): GeneratedHarnessStream`,
        `  ${handlerName}(handler: (stream: GeneratedHarnessStream) => Promise<void> | void): void`
      ]
    }
    return [
      `  ${methodName}(input: Record<string, WireValue>): Promise<Record<string, WireValue>>`,
      `  ${handlerName}(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void`
    ]
  })
  return `import type { HarnessStream } from '../../lib/transport.ts'

export type WireValue =
  | boolean
  | number
  | string
  | null
  | WireValue[]
  | { [key: string]: WireValue }

export interface GeneratedHarnessStream extends AsyncIterable<Record<string, WireValue>> {
  on(event: 'data', listener: (frame: Record<string, WireValue>) => void): object
  on(event: 'error', listener: (error: Error) => void): object
  on(event: 'close' | 'end', listener: () => void): object
  write(frame: Record<string, WireValue>): boolean
  end(): void
  destroy(): void
  readStream?: {
    on(event: 'close', listener: () => void): object
  }
}

export type GeneratedRunStream = GeneratedHarnessStream

export default class HarnessRPC {
  constructor(stream: HarnessStream)
${methods.join('\n')}
}
`
}

function camelCase(name: string) {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

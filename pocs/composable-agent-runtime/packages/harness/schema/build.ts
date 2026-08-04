import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import HRPCBuilder from 'hrpc'
import Hyperschema from 'hyperschema'
import { registerHarnessApi, registerHarnessTypes } from './harness.ts'
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

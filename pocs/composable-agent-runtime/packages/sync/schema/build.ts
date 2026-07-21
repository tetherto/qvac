import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import HRPCBuilder from 'hrpc'
import HyperDB from 'hyperdb/builder'
import Hyperdispatch from 'hyperdispatch'
import Hyperschema from 'hyperschema'
import HyperschemaTS from 'hyperschema-ts'
import { writeBoundary } from './generate.ts'
import {
  registerLocalCollections,
  registerLocalTypes,
  registerMeshCollections,
  registerMeshDispatch,
  registerMeshTypes,
  registerRpcApi,
  registerRpcTypes
} from './sync.ts'

const packageDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const specDirectory = path.join(packageDirectory, 'spec')
const rpcSchemaDirectory = path.join(specDirectory, 'rpc', 'hyperschema')
const rpcDirectory = path.join(specDirectory, 'rpc')
const localSchemaDirectory = path.join(specDirectory, 'local', 'hyperschema')
const localDatabaseDirectory = path.join(specDirectory, 'local', 'hyperdb')
const meshSchemaDirectory = path.join(specDirectory, 'mesh', 'hyperschema')
const meshDatabaseDirectory = path.join(specDirectory, 'mesh', 'hyperdb')
const meshDispatchDirectory = path.join(specDirectory, 'mesh', 'hyperdispatch')

fs.mkdirSync(specDirectory, { recursive: true })
for (const directory of [
  rpcSchemaDirectory,
  path.join(rpcDirectory, 'hrpc'),
  localSchemaDirectory,
  localDatabaseDirectory,
  meshSchemaDirectory,
  meshDatabaseDirectory,
  meshDispatchDirectory
]) {
  fs.rmSync(directory, { recursive: true, force: true })
}

const rpcSchema = Hyperschema.from(rpcSchemaDirectory)
registerRpcTypes(rpcSchema.namespace('rpc'))
Hyperschema.toDisk(rpcSchema, { esm: true })
HyperschemaTS.toDisk(rpcSchema)

const rpc = HRPCBuilder.from(rpcSchemaDirectory, path.join(rpcDirectory, 'hrpc'))
registerRpcApi(rpc.namespace('rpc'))
HRPCBuilder.toDisk(rpc)
writeBoundary(rpc, rpcDirectory)

const localSchema = Hyperschema.from(localSchemaDirectory)
registerLocalTypes(localSchema.namespace('local'))
Hyperschema.toDisk(localSchema, { esm: true })
HyperschemaTS.toDisk(localSchema)
const localDatabase = HyperDB.from(localSchemaDirectory, localDatabaseDirectory)
registerLocalCollections(localDatabase.namespace('local'))
HyperDB.toDisk(localDatabase, { esm: true })

const meshSchema = Hyperschema.from(meshSchemaDirectory)
registerMeshTypes(meshSchema.namespace('sync'))
Hyperschema.toDisk(meshSchema, { esm: true })
HyperschemaTS.toDisk(meshSchema)
const meshDatabase = HyperDB.from(meshSchemaDirectory, meshDatabaseDirectory)
registerMeshCollections(meshDatabase.namespace('sync'))
HyperDB.toDisk(meshDatabase, { esm: true })
const meshDispatch = Hyperdispatch.from(meshSchemaDirectory, meshDispatchDirectory)
registerMeshDispatch(meshDispatch.namespace('sync'))
Hyperdispatch.toDisk(meshDispatch)

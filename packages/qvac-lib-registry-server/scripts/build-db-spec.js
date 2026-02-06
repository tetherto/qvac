'use strict'

/**
 * Build DB Specification
 *
 * IMPORTANT: This script MUST be run:
 * 1. Before first time setup (initial service run)
 * 2. After ANY schema changes in lib/generate-schema.js
 * 3. After ANY changes to collections or indexes
 */

const path = require('path')
const HyperDBBuilder = require('hyperdb/builder')
const Hyperdispatch = require('hyperdispatch')
const Hyperschema = require('hyperschema')
const generateQVACRegistrySchema = require('../lib/generate-schema')
const { QVAC_MAIN_REGISTRY } = require('@tetherto/qvac-registry-schema-mono')

const SCHEMA_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperschema')
const DB_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperdb')
const DISPATCH_DIR = path.join(__dirname, '..', 'shared', 'spec', 'hyperdispatch')

const schema = Hyperschema.from(SCHEMA_DIR)
generateQVACRegistrySchema(schema)
Hyperschema.toDisk(schema)

const db = HyperDBBuilder.from(SCHEMA_DIR, DB_DIR)
const registryDB = db.namespace(QVAC_MAIN_REGISTRY)
registryDB.require('shared/db-helpers.js')

registryDB.collections.register({
  name: 'license',
  schema: `@${QVAC_MAIN_REGISTRY}/license`,
  key: ['spdxId']
})

registryDB.collections.register({
  name: 'model',
  schema: `@${QVAC_MAIN_REGISTRY}/model`,
  key: ['path', 'source']
})

registryDB.indexes.register({
  name: 'models-by-engine',
  collection: `@${QVAC_MAIN_REGISTRY}/model`,
  unique: false,
  key: ['engine']
})

registryDB.indexes.register({
  name: 'models-by-name',
  collection: `@${QVAC_MAIN_REGISTRY}/model`,
  unique: false,
  key: {
    type: 'string',
    map: 'mapPathToName'
  }
})

registryDB.indexes.register({
  name: 'models-by-quantization',
  collection: `@${QVAC_MAIN_REGISTRY}/model`,
  unique: false,
  key: ['quantization']
})

HyperDBBuilder.toDisk(db)

const dispatch = Hyperdispatch.from(SCHEMA_DIR, DISPATCH_DIR)
const namespace = dispatch.namespace(QVAC_MAIN_REGISTRY)

namespace.register({
  name: 'put-model',
  requestType: `@${QVAC_MAIN_REGISTRY}/model`
})

namespace.register({
  name: 'put-license',
  requestType: `@${QVAC_MAIN_REGISTRY}/license`
})

namespace.register({
  name: 'add-indexer',
  requestType: `@${QVAC_MAIN_REGISTRY}/writer`
})

namespace.register({
  name: 'remove-indexer',
  requestType: `@${QVAC_MAIN_REGISTRY}/writer`
})

Hyperdispatch.toDisk(dispatch)

console.log('✓ Registry DB spec built successfully!')
console.log(`  Schema output: ${SCHEMA_DIR}`)
console.log(`  DB spec output: ${DB_DIR}`)
console.log(`  Dispatch output: ${DISPATCH_DIR}`)

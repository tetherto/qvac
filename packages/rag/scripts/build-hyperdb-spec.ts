import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import HyperDB from 'hyperdb/builder'
import Hyperschema from 'hyperschema'

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url))
const packageRoot = path.join(scriptDir, '..')

const SCHEMA_DIR = path.join(packageRoot, 'src', 'db', 'hyperspec', 'hyperschema')
const DB_DIR = path.join(packageRoot, 'src', 'db', 'hyperspec', 'hyperdb')

buildRAGSchema()
buildRAGDatabase()

// Native IDs are u64 values stored as 8 big-endian bytes, since HyperDB keys
// cannot hold a BigInt and big-endian bytes sort in numeric order.
function buildRAGSchema(schemaDir: string = SCHEMA_DIR) {
  const schema = Hyperschema.from(schemaDir)
  const rag = schema.namespace('rag')

  rag.register({
    name: 'spaces',
    fields: [
      { name: 'spaceId', type: 'string', required: true },
      { name: 'model', type: 'string', required: true },
      { name: 'revision', type: 'string', required: true },
      { name: 'dimensions', type: 'uint', required: true },
      { name: 'metric', type: 'string', required: true },
      { name: 'normalized', type: 'bool', required: true },
      { name: 'documentEncoding', type: 'string', required: true },
      { name: 'queryEncoding', type: 'string', required: true },
      { name: 'preprocessing', type: 'string', required: true }
    ]
  })

  rag.register({
    name: 'namespaces',
    fields: [
      { name: 'name', type: 'string', required: true },
      { name: 'spaceId', type: 'string', required: true },
      { name: 'revision', type: 'uint', required: true },
      { name: 'nextNativeId', type: 'buffer', required: true },
      { name: 'createdAt', type: 'date', required: true }
    ]
  })

  rag.register({
    name: 'documents',
    fields: [
      { name: 'namespace', type: 'string', required: true },
      { name: 'documentId', type: 'string', required: true },
      { name: 'generation', type: 'uint', required: true },
      { name: 'chunkCount', type: 'uint', required: true },
      { name: 'contentHash', type: 'string', required: true },
      { name: 'metadata', type: 'json', required: false },
      { name: 'updatedAt', type: 'date', required: true }
    ]
  })

  rag.register({
    name: 'chunks',
    fields: [
      { name: 'namespace', type: 'string', required: true },
      { name: 'documentId', type: 'string', required: true },
      { name: 'generation', type: 'uint', required: true },
      { name: 'ordinal', type: 'uint', required: true },
      { name: 'chunkId', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'metadataJson', type: 'string', required: false },
      { name: 'nativeId', type: 'buffer', required: true },
      { name: 'vector', type: 'buffer', required: true }
    ]
  })

  rag.register({
    name: 'nativeIds',
    fields: [
      { name: 'namespace', type: 'string', required: true },
      { name: 'nativeId', type: 'buffer', required: true },
      { name: 'documentId', type: 'string', required: true },
      { name: 'generation', type: 'uint', required: true },
      { name: 'ordinal', type: 'uint', required: true }
    ]
  })

  // `added` and `removed` hold packed native IDs, 8 big-endian bytes each.
  rag.register({
    name: 'mutations',
    fields: [
      { name: 'namespace', type: 'string', required: true },
      { name: 'revision', type: 'uint', required: true },
      { name: 'added', type: 'buffer', required: true },
      { name: 'removed', type: 'buffer', required: true },
      { name: 'createdAt', type: 'date', required: true }
    ]
  })

  Hyperschema.toDisk(schema, { esm: false })

  console.log('RAG HyperDB schema generated')
}

function buildRAGDatabase(schemaDir: string = SCHEMA_DIR, dbDir: string = DB_DIR) {
  const db = HyperDB.from(schemaDir, dbDir)
  const dbNs = db.namespace('rag')

  dbNs.collections.register({ name: 'spaces', schema: '@rag/spaces', key: ['spaceId'] })
  dbNs.collections.register({ name: 'namespaces', schema: '@rag/namespaces', key: ['name'] })
  dbNs.collections.register({
    name: 'documents',
    schema: '@rag/documents',
    key: ['namespace', 'documentId']
  })
  dbNs.collections.register({
    name: 'chunks',
    schema: '@rag/chunks',
    key: ['namespace', 'documentId', 'generation', 'ordinal']
  })
  dbNs.collections.register({
    name: 'nativeIds',
    schema: '@rag/nativeIds',
    key: ['namespace', 'nativeId']
  })
  dbNs.collections.register({
    name: 'mutations',
    schema: '@rag/mutations',
    key: ['namespace', 'revision']
  })

  HyperDB.toDisk(db, { esm: false })
  removeUnusedRuntimeImport(path.join(dbDir, 'index.js'))

  console.log(`RAG HyperDB spec written to ${dbDir}`)
}

// The hyperdb builder emits an unused `c` binding in its runtime import; drop it
// so the generated spec lints cleanly.
function removeUnusedRuntimeImport(indexPath: string) {
  const content = fs.readFileSync(indexPath, 'utf8')
  if (content.includes('c.')) return
  const updated = content.replace(
    "const { IndexEncoder, c, b4a } = require('hyperdb/runtime')",
    "const { IndexEncoder, b4a } = require('hyperdb/runtime')"
  )

  if (updated !== content) {
    fs.writeFileSync(indexPath, updated)
  }
}

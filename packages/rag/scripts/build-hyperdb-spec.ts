import fs from 'bare-fs'
import path from 'bare-path'
import HyperDB from 'hyperdb/builder'
import Hyperschema from 'hyperschema'

const scriptDir = path.dirname(new URL(import.meta.url).pathname)
const packageRoot = path.join(scriptDir, '..')

const SCHEMA_DIR = path.join(packageRoot, 'src', 'adapters', 'database', 'hyperspec', 'hyperschema')
const DB_DIR = path.join(packageRoot, 'src', 'adapters', 'database', 'hyperspec', 'hyperdb')

buildRAGSchema()
buildRAGDatabase()

// Builds the RAG schema specification using hyperschema.
function buildRAGSchema(schemaDir: string = SCHEMA_DIR) {
  const schema = Hyperschema.from(schemaDir)
  const rag = schema.namespace('rag')

  // Register the Document type
  rag.register({
    name: 'documents',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'contentHash', type: 'string', required: true },
      { name: 'createdAt', type: 'date', required: true },
      { name: 'updatedAt', type: 'date', required: true },
      { name: 'metadata', type: 'json', required: false }
    ]
  })

  // Register the Vector type
  rag.register({
    name: 'vectors',
    fields: [
      { name: 'docId', type: 'string', required: true },
      { name: 'vector', type: 'json', required: true },
      { name: 'createdAt', type: 'date', required: true }
    ]
  })

  // Register the Centroid type
  rag.register({
    name: 'centroids',
    fields: [
      { name: 'id', type: 'string', required: true },
      { name: 'vector', type: 'json', required: true },
      { name: 'index', type: 'uint32', required: true },
      { name: 'createdAt', type: 'date', required: true }
    ]
  })

  // Register the IVF Bucket type
  rag.register({
    name: 'ivfBuckets',
    fields: [
      { name: 'centroidId', type: 'string', required: true },
      { name: 'documentIds', type: 'json', required: true },
      { name: 'capacity', type: 'uint32', required: true },
      { name: 'createdAt', type: 'date', required: true },
      { name: 'updatedAt', type: 'date', required: true }
    ]
  })

  // Register the Config type
  rag.register({
    name: 'config',
    fields: [
      { name: 'key', type: 'string', required: true },
      { name: 'embeddingModelId', type: 'string', required: true },
      { name: 'dimension', type: 'uint32', required: true },
      { name: 'NUM_CENTROIDS', type: 'uint32', required: true },
      { name: 'BUCKET_SIZE', type: 'uint32', required: true },
      { name: 'BATCH_SIZE', type: 'uint32', required: true },
      { name: 'createdAt', type: 'date', required: true }
    ]
  })

  Hyperschema.toDisk(schema)

  console.log('✅ RAG HyperDB schema generated successfully!')
}

// Builds the RAG database specification using hyperschema and the hyperdb builder.
function buildRAGDatabase(schemaDir: string = SCHEMA_DIR, dbDir: string = DB_DIR) {
  const db = HyperDB.from(schemaDir, dbDir)
  const dbNs = db.namespace('rag')

  // Register collections
  dbNs.collections.register({ name: 'documents', schema: '@rag/documents', key: ['id'] })
  dbNs.collections.register({ name: 'vectors', schema: '@rag/vectors', key: ['docId'] })
  dbNs.collections.register({ name: 'centroids', schema: '@rag/centroids', key: ['id'] })
  dbNs.collections.register({ name: 'ivfBuckets', schema: '@rag/ivfBuckets', key: ['centroidId'] })
  dbNs.collections.register({ name: 'config', schema: '@rag/config', key: ['key'] })

  // Register indexes
  dbNs.indexes.register({
    name: 'doc-by-content-hash',
    collection: '@rag/documents',
    key: ['contentHash']
  })

  HyperDB.toDisk(db)
  removeUnusedRuntimeImport(path.join(dbDir, 'index.js'))

  console.log('✅ RAG HyperDB specification built successfully!')
  console.log(`📁 Schema saved to: ${schemaDir}`)
  console.log(`📁 Database files saved to: ${dbDir}`)
}

// The hyperdb builder emits an unused `c` binding in its runtime import; drop it
// so the generated spec lints cleanly.
function removeUnusedRuntimeImport(indexPath: string) {
  const content = fs.readFileSync(indexPath, 'utf8')
  const updated = content.replace(
    "const { IndexEncoder, c, b4a } = require('hyperdb/runtime')",
    "const { IndexEncoder, b4a } = require('hyperdb/runtime')"
  )

  if (updated !== content) {
    fs.writeFileSync(indexPath, updated)
  }
}

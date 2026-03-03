const path = require('bare-path')
const HyperDB = require('hyperdb/builder')
const Hyperschema = require('hyperschema')

const SCHEMA_DIR = path.join(__dirname, '..', 'src', 'adapters', 'database', 'hyperspec', 'hyperschema')
const DB_DIR = path.join(__dirname, '..', 'src', 'adapters', 'database', 'hyperspec', 'hyperdb')

buildRAGSchema()
buildRAGDatabase()

/**
 * Builds the RAG schema specification using hyperschema
 * @param {string} [schemaDir] - Directory to save schema files
 * @returns {void}
 */
function buildRAGSchema (schemaDir = SCHEMA_DIR) {
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

/**
 * Builds the RAG database specification using hyperschema and hyperdb builder
 * @param {string} [schemaDir] - Directory containing schema files
 * @param {string} [dbDir] - Directory to save database files
 * @returns {void}
 */
function buildRAGDatabase (schemaDir = SCHEMA_DIR, dbDir = DB_DIR) {
  const db = HyperDB.from(schemaDir, dbDir)
  const dbNs = db.namespace('rag')

  // Register collections
  dbNs.collections.register({
    name: 'documents',
    schema: '@rag/documents',
    key: ['id']
  })

  dbNs.collections.register({
    name: 'vectors',
    schema: '@rag/vectors',
    key: ['docId']
  })

  dbNs.collections.register({
    name: 'centroids',
    schema: '@rag/centroids',
    key: ['id']
  })

  dbNs.collections.register({
    name: 'ivfBuckets',
    schema: '@rag/ivfBuckets',
    key: ['centroidId']
  })

  dbNs.collections.register({
    name: 'config',
    schema: '@rag/config',
    key: ['key']
  })

  // Register indexes
  dbNs.indexes.register({
    name: 'doc-by-content-hash',
    collection: '@rag/documents',
    key: ['contentHash']
  })

  HyperDB.toDisk(db)

  console.log('✅ RAG HyperDB specification built successfully!')
  console.log(`📁 Schema saved to: ${schemaDir}`)
  console.log(`📁 Database files saved to: ${dbDir}`)
  console.log('\n📝 IMPORTANT: Generated hyperspec files have been manually converted to use dynamic imports')
  console.log('   This prevents static dependency resolution when HyperDBAdapter is not used.')
  console.log('   If you regenerate specs, you\'ll need to manually convert static requires to dynamic imports.')
}

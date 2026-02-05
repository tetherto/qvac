'use strict'

const { QVAC_MAIN_REGISTRY } = require('@tetherto/qvac-registry-schema-mono')

module.exports = function generateQVACRegistrySchema (schema) {
  schema.register({
    name: 'model-blob-binding',
    namespace: QVAC_MAIN_REGISTRY,
    fields: [
      { name: 'coreKey', type: 'fixed32', required: true },
      { name: 'blockOffset', type: 'uint', required: true },
      { name: 'blockLength', type: 'uint', required: true },
      { name: 'byteOffset', type: 'uint', required: true },
      { name: 'byteLength', type: 'uint', required: true },
      { name: 'sha256', type: 'string', required: true }
    ]
  })

  schema.register({
    name: 'license',
    namespace: QVAC_MAIN_REGISTRY,
    fields: [
      { name: 'spdxId', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'url', type: 'string', required: true },
      { name: 'text', type: 'string', required: true }
    ]
  })

  schema.register({
    name: 'model',
    namespace: QVAC_MAIN_REGISTRY,
    fields: [
      { name: 'path', type: 'string', required: true },
      { name: 'source', type: 'string', required: true },
      { name: 'engine', type: 'string', required: true },
      { name: 'licenseId', type: 'string', required: true },
      { name: 'blobBinding', type: `@${QVAC_MAIN_REGISTRY}/model-blob-binding`, required: true },
      { name: 'quantization', type: 'string', required: false },
      { name: 'params', type: 'string', required: false },
      { name: 'description', type: 'string', required: false },
      { name: 'notes', type: 'string', required: false },
      { name: 'tags', type: 'string', array: true, required: false },
      { name: 'deprecated', type: 'bool', required: false },
      { name: 'deprecatedAt', type: 'string', required: false },
      { name: 'replacedBy', type: 'string', required: false },
      { name: 'deprecationReason', type: 'string', required: false },
      { name: 'ggufMetadata', type: 'string', required: false }
    ]
  })

  schema.register({
    name: 'model-key',
    namespace: QVAC_MAIN_REGISTRY,
    fields: [
      { name: 'path', type: 'string', required: true },
      { name: 'source', type: 'string', required: true }
    ]
  })

  schema.register({
    name: 'writer',
    namespace: QVAC_MAIN_REGISTRY,
    fields: [
      { name: 'key', type: 'fixed32', required: true }
    ]
  })
}

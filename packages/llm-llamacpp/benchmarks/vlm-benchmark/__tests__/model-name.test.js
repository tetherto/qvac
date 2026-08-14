'use strict'

// modelName from a json: spec is concatenated into a path, "$MODEL_DIR/$LLM_NAME" in
// benchmark-vlm-model-comparison.yml, and handed to curl -o. The validation in models.cjs is
// the only thing standing between a caller-supplied string and that path, so the cases that
// matter are the ones that are a path segment without containing a slash.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseModels } = require('../models.cjs')

function parseWithName (modelName) {
  const spec = {
    label: 'probe',
    llm: { source: { type: 'url', url: 'https://example.com/llm.gguf' }, modelName },
    mmproj: { source: { type: 'url', url: 'https://example.com/mmproj.gguf' }, modelName: 'mmproj.gguf' }
  }
  return parseModels('json:' + JSON.stringify([spec]), null, null)[0]
}

const REJECTED = [
  ['parent directory', '..'],
  ['current directory', '.'],
  ['three dots is still all dots', '...'],
  ['explicit traversal', '../escape.gguf'],
  ['absolute path', '/etc/passwd'],
  ['nested path', 'sub/dir.gguf']
]

for (const [why, modelName] of REJECTED) {
  test(`modelName rejected: ${why}`, () => {
    assert.throws(() => parseWithName(modelName), /must be a bare filename/)
  })
}

const ACCEPTED = [
  ['plain gguf', 'visionpsy-nano-460m-q8_0.gguf'],
  ['leading dot is a hidden file, not a traversal', '.hidden.gguf'],
  ['dots inside a name', 'a..b.gguf'],
  ['dashes and underscores', 'mmproj-Qwen3.5-0.8B-F16.gguf']
]

for (const [why, modelName] of ACCEPTED) {
  test(`modelName accepted: ${why}`, () => {
    assert.equal(parseWithName(modelName).llm.modelName, modelName)
  })
}

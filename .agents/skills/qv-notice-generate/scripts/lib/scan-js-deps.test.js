'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { collectInstalledProductionKeys } = require('./scan-js-deps')

describe('collectInstalledProductionKeys', () => {
  it('keeps production transitives and skips extraneous peer trees', () => {
    const tree = {
      name: '@qvac/sdk',
      version: '0.20.0',
      dependencies: {
        '@qvac/asr-ggml': {
          version: '0.5.3',
          dependencies: {
            '@qvac/asr-ggml-darwin-arm64': { version: '0.5.3' }
          }
        },
        'react-native': {
          version: '0.87.1',
          extraneous: true,
          dependencies: {
            '@babel/core': { version: '7.29.7', extraneous: true }
          }
        }
      }
    }

    const keys = collectInstalledProductionKeys(tree)
    assert.deepEqual(
      [...keys].sort(),
      [
        '@qvac/asr-ggml-darwin-arm64@0.5.3',
        '@qvac/asr-ggml@0.5.3',
        '@qvac/sdk@0.20.0'
      ]
    )
  })

  it('does not recurse into missing or invalid nodes', () => {
    const tree = {
      name: '@qvac/cli',
      version: '0.14.0',
      dependencies: {
        optional: { missing: true },
        broken: { version: '1.0.0', invalid: true, dependencies: { nested: { version: '2.0.0' } } }
      }
    }
    const keys = collectInstalledProductionKeys(tree)
    assert.deepEqual([...keys], ['@qvac/cli@0.14.0'])
  })
})

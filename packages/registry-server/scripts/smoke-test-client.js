'use strict'

const path = require('path')
const fs = require('fs').promises
const os = require('os')

const { QVACRegistryClient } = require('../client')
const { parseCanonicalSource } = require('../lib/source-helpers')

const TIMEOUT_MS = 60000

async function smokeTest () {
  const args = process.argv.slice(2)
  const fileArg = args.find(arg => arg.startsWith('--file='))
  const filePath = fileArg ? fileArg.split('=')[1] : './data/models.prod.json'
  const jsonOutput = args.includes('--json')

  const result = {
    success: false,
    checks: [],
    error: null
  }

  const addCheck = (name, passed, details = null) => {
    result.checks.push({ name, passed, details })
    if (!jsonOutput && passed) {
      console.log(`✓ ${name}`)
    } else if (!jsonOutput && !passed) {
      console.error(`✗ ${name}${details ? ': ' + details : ''}`)
    }
  }

  let client = null
  const tmpStorage = path.join(os.tmpdir(), `qvac-smoke-test-${Date.now()}`)

  try {
    // Load expected models from config
    const resolvedPath = path.resolve(filePath)
    const configContent = await fs.readFile(resolvedPath, 'utf8')
    const configModels = JSON.parse(configContent)
    const expectedCount = configModels.length
    addCheck('Config loaded', true, `${expectedCount} models`)

    // Build expected paths set
    const expectedPaths = new Set()
    for (const model of configModels) {
      if (model.source) {
        try {
          const sourceInfo = parseCanonicalSource(model.source)
          expectedPaths.add(sourceInfo.path)
        } catch {
          // Skip invalid sources - validation script catches these
        }
      }
    }

    // Connect to registry
    const registryCoreKey = process.env.QVAC_REGISTRY_CORE_KEY
    if (!registryCoreKey) {
      throw new Error('QVAC_REGISTRY_CORE_KEY environment variable not set')
    }

    client = new QVACRegistryClient({
      registryCoreKey,
      storage: tmpStorage,
      logger: { level: 'error' }
    })

    // Wait for client with timeout
    await Promise.race([
      client.ready(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timeout connecting to registry')), TIMEOUT_MS)
      )
    ])
    addCheck('Connected to registry', true)

    // Fetch all models
    const models = await client.findModels({})
    addCheck('Fetched models', true, `${models.length} models`)

    // Verify model count
    if (models.length >= expectedCount) {
      addCheck('Model count matches', true, `${models.length} >= ${expectedCount}`)
    } else {
      addCheck('Model count matches', false, `${models.length} < ${expectedCount} expected`)
    }

    // Check sample model structure
    if (models.length > 0) {
      const sample = models[0]
      const hasRequiredFields = sample.path && sample.engine && sample.blobBinding
      const hasBlobBinding = sample.blobBinding &&
        typeof sample.blobBinding.blockOffset === 'number' &&
        typeof sample.blobBinding.blockLength === 'number' &&
        sample.blobBinding.coreKey

      if (hasRequiredFields && hasBlobBinding) {
        addCheck('Model structure valid', true, sample.path)
      } else {
        const missing = []
        if (!sample.path) missing.push('path')
        if (!sample.engine) missing.push('engine')
        if (!hasBlobBinding) missing.push('blobBinding')
        addCheck('Model structure valid', false, `missing: ${missing.join(', ')}`)
      }
    } else {
      addCheck('Model structure valid', false, 'no models to check')
    }

    // Check a few expected models exist
    let foundCount = 0
    const samplePaths = Array.from(expectedPaths).slice(0, 5)
    for (const expectedPath of samplePaths) {
      const found = models.some(m => m.path === expectedPath)
      if (found) foundCount++
    }

    if (samplePaths.length > 0) {
      if (foundCount === samplePaths.length) {
        addCheck('Sample models found', true, `${foundCount}/${samplePaths.length}`)
      } else {
        addCheck('Sample models found', false, `${foundCount}/${samplePaths.length}`)
      }
    }

    // Determine overall success
    result.success = result.checks.every(c => c.passed)
  } catch (err) {
    result.error = err.message
    if (!jsonOutput) {
      console.error(`\nError: ${err.message}`)
    }
  } finally {
    if (client) {
      try {
        await client.close()
      } catch {
        // Ignore close errors
      }
    }

    // Cleanup temp storage
    try {
      await fs.rm(tmpStorage, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log('')
    if (result.success) {
      console.log('Smoke test passed')
    } else {
      console.error('Smoke test failed')
    }
  }

  process.exit(result.success ? 0 : 1)
}

if (require.main === module) {
  smokeTest().catch(err => {
    console.error('Fatal error:', err.message)
    process.exit(1)
  })
}

module.exports = { smokeTest }

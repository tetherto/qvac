'use strict'

const fs = require('fs').promises
const os = require('os')
const path = require('path')
const IdEnc = require('hypercore-id-encoding')

const { QVACRegistryClient } = require('../client')
const RegistryConfig = require('../lib/config')

function parseArgs(args = process.argv.slice(2)) {
  const options = { json: false, registryKey: null }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--json') {
      options.json = true
    } else if (arg === '--registry-key' && args[i + 1]) {
      options.registryKey = args[++i]
    } else if (arg.startsWith('--registry-key=')) {
      options.registryKey = arg.slice('--registry-key='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new TypeError(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function createBlobCoreInventory(models) {
  if (!Array.isArray(models)) throw new TypeError('models must be an array')

  const byCore = new Map()
  let deprecatedModelCount = 0
  let referencedBytes = 0

  for (const model of models) {
    const binding = model?.blobBinding
    const modelId = `${model?.path || '<unknown>'}:${model?.source || '<unknown>'}`

    if (!binding) throw new TypeError(`Model ${modelId} has no blobBinding`)

    const coreKey = normalizeCoreKey(binding.coreKey, modelId)
    validateBindingNumber(binding.blockOffset, 'blockOffset', modelId)
    validateBindingNumber(binding.blockLength, 'blockLength', modelId)
    validateBindingNumber(binding.byteLength, 'byteLength', modelId)

    let core = byCore.get(coreKey)
    if (!core) {
      core = {
        coreKey,
        modelCount: 0,
        deprecatedModelCount: 0,
        referencedBytes: 0,
        referencedBlockEnd: 0
      }
      byCore.set(coreKey, core)
    }

    const blockEnd = binding.blockOffset + binding.blockLength
    core.modelCount++
    core.referencedBytes += binding.byteLength
    core.referencedBlockEnd = Math.max(core.referencedBlockEnd, blockEnd)
    referencedBytes += binding.byteLength

    if (model.deprecated === true) {
      core.deprecatedModelCount++
      deprecatedModelCount++
    }
  }

  const cores = Array.from(byCore.values()).sort((a, b) => a.coreKey.localeCompare(b.coreKey))

  return {
    summary: {
      coreCount: cores.length,
      modelCount: models.length,
      deprecatedModelCount,
      referencedBytes
    },
    cores
  }
}

function normalizeCoreKey(coreKey, modelId) {
  try {
    if (Buffer.isBuffer(coreKey)) return IdEnc.normalize(coreKey)
    if (typeof coreKey === 'string') return IdEnc.normalize(IdEnc.decode(coreKey))
    if (coreKey && Array.isArray(coreKey.data)) {
      return IdEnc.normalize(Buffer.from(coreKey.data))
    }
  } catch (err) {
    throw new TypeError(`Model ${modelId} has an invalid blobBinding.coreKey`, { cause: err })
  }

  throw new TypeError(`Model ${modelId} has an invalid blobBinding.coreKey`)
}

function validateBindingNumber(value, field, modelId) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Model ${modelId} has an invalid blobBinding.${field}`)
  }
}

async function checkBlobCores(options = {}) {
  const config = new RegistryConfig()
  const registryKey = options.registryKey || config.getRegistryCoreKey()

  if (!registryKey) {
    throw new Error('Set QVAC_REGISTRY_CORE_KEY or pass --registry-key <key>')
  }

  const storage = path.join(
    os.tmpdir(),
    `qvac-check-blob-cores-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  )
  const client = new QVACRegistryClient({
    registryCoreKey: registryKey,
    storage,
    logger: { level: 'error' }
  })

  try {
    await client.ready()
    const models = await client.findModels({}, { includeDeprecated: true })
    return createBlobCoreInventory(models)
  } finally {
    await client.close().catch(() => {})
    await fs.rm(storage, { recursive: true, force: true }).catch(() => {})
  }
}

function printInventory(inventory) {
  const { summary, cores } = inventory

  console.log('Blob core inventory')
  console.log(`Referenced cores: ${summary.coreCount}`)
  console.log(`Models: ${summary.modelCount} (${summary.deprecatedModelCount} deprecated)`)
  console.log(`Referenced bytes: ${summary.referencedBytes}`)

  for (const core of cores) {
    console.log(`\n${core.coreKey}`)
    console.log(`  Models: ${core.modelCount} (${core.deprecatedModelCount} deprecated)`)
    console.log(`  Referenced bytes: ${core.referencedBytes}`)
    console.log(`  Referenced block end: ${core.referencedBlockEnd}`)
  }
}

function printHelp() {
  console.log(`Usage: node scripts/check-blob-cores.js [options]

Options:
  --registry-key <key>  Registry view core key (defaults to QVAC_REGISTRY_CORE_KEY)
  --json                Print machine-readable JSON
  --help, -h            Show this help message

The command inventories blob cores referenced by registry model metadata. It does
not connect to blob cores or download model payloads.`)
}

async function main() {
  const options = parseArgs()
  if (options.help) {
    printHelp()
    return
  }

  const inventory = await checkBlobCores(options)
  if (options.json) console.log(JSON.stringify(inventory, null, 2))
  else printInventory(inventory)
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Failed to inspect blob cores: ${err.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  checkBlobCores,
  createBlobCoreInventory,
  parseArgs,
  printInventory
}

'use strict'

/**
 * Migration: Fix S3 model paths that incorrectly include bucket name
 *
 * Background:
 * A bug in source-helpers.js caused S3 model paths to include the bucket name:
 *   - Wrong: "tether-ai-dev/qvac_models_compiled/ggml/..."
 *   - Correct: "qvac_models_compiled/ggml/..."
 *
 * This migration fixes existing records by:
 * 1. Finding all S3 models where path starts with bucket name
 * 2. Deleting the old record
 * 3. Inserting a new record with corrected path (preserving blobBinding)
 *
 * Prerequisites:
 * - Stop the registry service before running
 * - Run from the same machine with access to the storage directory
 *
 * Usage:
 *   node migrations/001-fix-s3-bucket-in-path.js --bucket=<bucket-name> --storage=<path> [--bootstrap=<key>] [--dry-run]
 *
 * Example:
 *   node migrations/001-fix-s3-bucket-in-path.js --bucket=tether-ai-dev --storage=./storage --dry-run
 *   node migrations/001-fix-s3-bucket-in-path.js --bucket=tether-ai-dev --storage=./storage --bootstrap=<autobase-key>
 *
 * The bootstrap key can also be read from .env file (QVAC_AUTOBASE_KEY)
 */

const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const Autobase = require('autobase')
const IdEnc = require('hypercore-id-encoding')

const schema = require('@tetherto/qvac-registry-schema')
const { Router, encode: encodeDispatch } = schema.hyperdispatchSpec
const RegistryDatabase = schema.RegistryDatabase
const { QVAC_MAIN_REGISTRY } = schema

const DISPATCH_PUT_MODEL = `@${QVAC_MAIN_REGISTRY}/put-model`
const DISPATCH_PUT_LICENSE = `@${QVAC_MAIN_REGISTRY}/put-license`
const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`
const DISPATCH_REMOVE_INDEXER = `@${QVAC_MAIN_REGISTRY}/remove-indexer`
const DISPATCH_DELETE_MODEL = `@${QVAC_MAIN_REGISTRY}/delete-model`

function readEnvFile () {
  const envPath = path.resolve('.env')
  const env = {}
  try {
    const content = fs.readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim()
        const value = trimmed.slice(eqIndex + 1).trim()
        env[key] = value
      }
    }
  } catch {
    // .env file not found, ignore
  }
  return env
}

function parseArgs () {
  const args = process.argv.slice(2)
  const env = readEnvFile()

  const result = {
    bucket: null,
    storage: null,
    bootstrap: null,
    dryRun: false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--bucket=')) {
      result.bucket = arg.split('=')[1]
    } else if (arg.startsWith('--storage=')) {
      result.storage = arg.split('=')[1]
    } else if (arg.startsWith('--bootstrap=')) {
      result.bootstrap = arg.split('=')[1]
    } else if (arg === '--dry-run') {
      result.dryRun = true
    }
  }

  // Fall back to .env for bootstrap key
  if (!result.bootstrap && env.QVAC_AUTOBASE_KEY) {
    result.bootstrap = env.QVAC_AUTOBASE_KEY
    console.log('Using QVAC_AUTOBASE_KEY from .env file')
  }

  return result
}

function printUsage () {
  console.log('Usage: node migrations/001-fix-s3-bucket-in-path.js --bucket=<name> --storage=<path> [--bootstrap=<key>] [--dry-run]')
  console.log('')
  console.log('Options:')
  console.log('  --bucket=<name>     S3 bucket name to remove from paths (required)')
  console.log('  --storage=<path>    Path to registry storage directory (required)')
  console.log('  --bootstrap=<key>   Autobase bootstrap key (hex or z32, reads from existing storage if not provided)')
  console.log('  --dry-run           Show what would be changed without making changes')
  console.log('')
  console.log('Example:')
  console.log('  node migrations/001-fix-s3-bucket-in-path.js --bucket=tether-ai-dev --storage=./storage --dry-run')
}

async function runMigration () {
  const opts = parseArgs()

  if (!opts.bucket || !opts.storage) {
    printUsage()
    process.exit(1)
  }

  if (!opts.bootstrap) {
    console.error('ERROR: Bootstrap key is required. Pass --bootstrap=<key> or set QVAC_AUTOBASE_KEY in .env')
    printUsage()
    process.exit(1)
  }

  const storagePath = path.resolve(opts.storage)
  const bucketPrefix = opts.bucket + '/'

  console.log('=== S3 Path Migration ===')
  console.log(`Storage: ${storagePath}`)
  console.log(`Bucket prefix to remove: ${bucketPrefix}`)
  if (opts.dryRun) {
    console.log('Mode: DRY RUN (no changes will be made)')
  }
  console.log('')

  const store = new Corestore(storagePath)
  await store.ready()

  let bootstrapKey
  try {
    bootstrapKey = IdEnc.decode(opts.bootstrap)
    console.log('Bootstrap key (hex):', bootstrapKey.toString('hex'))
  } catch (err) {
    console.error('Invalid bootstrap key format:', err.message)
    process.exit(1)
  }

  const applyRouter = new Router()

  applyRouter.add(DISPATCH_PUT_MODEL, async (model, context) => {
    await context.view.putModel(model)
  })

  applyRouter.add(DISPATCH_PUT_LICENSE, async (license, context) => {
    await context.view.putLicense(license)
  })

  applyRouter.add(DISPATCH_ADD_INDEXER, async ({ key }, context) => {
    await context.base.addWriter(key, { indexer: true })
  })

  applyRouter.add(DISPATCH_REMOVE_INDEXER, async ({ key }, context) => {
    await context.base.removeWriter(key)
  })

  applyRouter.add(DISPATCH_DELETE_MODEL, async ({ path, source }, context) => {
    await context.view.deleteModel(path, source)
  })

  function openView (store) {
    const dbCore = store.get('db-view')
    return new RegistryDatabase(dbCore, { extension: false })
  }

  async function closeView (view) {
    await view.close()
  }

  async function apply (nodes, view, base) {
    if (!view.opened) await view.ready()
    for (const node of nodes) {
      const op = node.value
      await applyRouter.dispatch(op, { view, base })
    }
  }

  const base = new Autobase(store, bootstrapKey, {
    open: openView,
    apply,
    close: closeView,
    ackInterval: 1000
  })

  await base.ready()

  console.log('Autobase key:', base.key.toString('hex'))
  console.log('Autobase writable:', base.writable)
  console.log('Autobase local input length:', base.localWriter?.length ?? 'N/A')
  console.log('')

  if (!base.writable) {
    console.error('ERROR: Autobase is not writable. Make sure you are running on the writer node.')
    await base.close()
    await store.close()
    process.exit(1)
  }

  const view = base.view
  await view.ready()

  console.log('View core length:', view.core?.length ?? 'N/A')
  console.log('Updating view...')
  await base.update()
  console.log('View core length after update:', view.core?.length ?? 'N/A')
  console.log('')

  const allModels = await view.findModelsByPath({}).toArray()
  console.log(`Total models in database: ${allModels.length}`)

  const s3Models = allModels.filter(m => m.source === 's3')
  console.log(`S3 models: ${s3Models.length}`)

  const affectedModels = s3Models.filter(m => m.path.startsWith(bucketPrefix))
  console.log(`Models with bucket prefix in path: ${affectedModels.length}`)
  console.log('')

  if (affectedModels.length === 0) {
    console.log('No models need migration.')
    await base.close()
    await store.close()
    return
  }

  const report = { migrated: [], skipped: [], errors: [] }

  for (const model of affectedModels) {
    const oldPath = model.path
    const newPath = oldPath.slice(bucketPrefix.length)

    console.log(`Processing: ${oldPath}`)
    console.log(`  -> ${newPath}`)

    const existingAtNewPath = await view.getModel(newPath, 's3')
    if (existingAtNewPath) {
      console.log('  SKIP: Target path already exists')
      report.skipped.push({ oldPath, newPath, reason: 'target exists' })
      continue
    }

    if (opts.dryRun) {
      console.log('  [DRY RUN] Would migrate')
      report.migrated.push({ oldPath, newPath })
      continue
    }

    try {
      await base.append(encodeDispatch(DISPATCH_DELETE_MODEL, { path: oldPath, source: 's3' }))

      const migratedModel = { ...model, path: newPath }
      await base.append(encodeDispatch(DISPATCH_PUT_MODEL, migratedModel))

      console.log('  ✓ Migrated')
      report.migrated.push({ oldPath, newPath })
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`)
      report.errors.push({ oldPath, newPath, error: err.message })
    }
  }

  if (!opts.dryRun && report.migrated.length > 0) {
    console.log('')
    console.log('Waiting for autobase to flush...')
    await base.update()
  }

  console.log('')
  console.log('=== Migration Report ===')
  console.log(`Migrated: ${report.migrated.length}`)
  console.log(`Skipped: ${report.skipped.length}`)
  console.log(`Errors: ${report.errors.length}`)

  if (report.errors.length > 0) {
    console.log('')
    console.log('Errors:')
    for (const err of report.errors) {
      console.log(`  ${err.oldPath}: ${err.error}`)
    }
  }

  if (opts.dryRun && report.migrated.length > 0) {
    console.log('')
    console.log('Run without --dry-run to apply changes')
  }

  await base.close()
  await store.close()

  return report
}

if (require.main === module) {
  runMigration()
    .then(report => {
      const hasErrors = report && report.errors && report.errors.length > 0
      process.exit(hasErrors ? 1 : 0)
    })
    .catch(err => {
      console.error('Fatal error:', err)
      process.exit(1)
    })
}

module.exports = { runMigration }

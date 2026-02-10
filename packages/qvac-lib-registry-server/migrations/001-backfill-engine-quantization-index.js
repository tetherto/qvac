#!/usr/bin/env node
'use strict'

/**
 * Migration: Backfill compound index `models-by-engine-quantization`
 *
 * HyperDB writes index keys at insert time from the current spec.
 * Records inserted before the compound index existed have no keys
 * for `models-by-engine-quantization`. Autobase does not replay
 * the full log on restart, so a plain restart leaves the new index
 * empty for existing data.
 *
 * This script re-appends every model through Autobase's dispatch
 * pipeline with a custom apply handler that calls HyperDB insert
 * with `force: true`, bypassing the identical-value short-circuit
 * so all index keys (including the new compound one) are written.
 *
 * Prerequisites:
 *   - PR #145 merged (new spec with `models-by-engine-quantization`)
 *   - `npm run build:spec` already run
 *   - Staging server STOPPED (only one Autobase instance per storage)
 *   - Run from the registry-server package directory
 *
 * Usage:
 *   node migrations/001-backfill-engine-quantization-index.js --storage <path> [options]
 *
 * Options:
 *   --storage, -s <path>    Corestore path (same as server's --storage)
 *   --bootstrap, -b <key>   Autobase bootstrap key (hex, or reads QVAC_AUTOBASE_KEY from .env)
 *   --dry-run               Read models and report count, do not write
 *   --batch-size <n>        Append batch size (default: 50)
 */

require('dotenv').config()

const Autobase = require('autobase')
const Corestore = require('corestore')
const IdEnc = require('hypercore-id-encoding')
const pino = require('pino')

const schema = require('@tetherto/qvac-registry-schema-mono')
const { Router, encode: encodeDispatch } = schema.hyperdispatchSpec
const { QVAC_MAIN_REGISTRY, AUTOBASE_NAMESPACE } = schema

const DISPATCH_PUT_MODEL = `@${QVAC_MAIN_REGISTRY}/put-model`
const DISPATCH_PUT_LICENSE = `@${QVAC_MAIN_REGISTRY}/put-license`
const DISPATCH_ADD_INDEXER = `@${QVAC_MAIN_REGISTRY}/add-indexer`
const DISPATCH_REMOVE_INDEXER = `@${QVAC_MAIN_REGISTRY}/remove-indexer`
const DISPATCH_DELETE_MODEL = `@${QVAC_MAIN_REGISTRY}/delete-model`

const DEFAULT_BATCH_SIZE = 50

// ---------------------------------------------------------------------------
// Minimal RegistryDatabase that supports force-insert
// ---------------------------------------------------------------------------

const ReadyResource = require('ready-resource')
const HyperDB = require('hyperdb')
const dbSpec = require('@tetherto/qvac-registry-schema-mono').hyperdbSpec

class MigrationDatabase extends ReadyResource {
  constructor (core, { extension = true } = {}) {
    super()
    this.db = HyperDB.bee(core, dbSpec, { autoUpdate: true, extension })
  }

  get core () { return this.db.core }
  async _open () { await this.db.ready() }
  async _close () { await this.db.close() }

  /** Standard insert (no force) — used by non-model handlers */
  async putModel (record) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert(`@${QVAC_MAIN_REGISTRY}/model`, record)
    await tx.flush()
  }

  /** Force-insert: bypasses identical-value check so new index keys are written */
  async putModelForce (record) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert(`@${QVAC_MAIN_REGISTRY}/model`, record, { force: true })
    await tx.flush()
  }

  async putLicense (record) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.insert(`@${QVAC_MAIN_REGISTRY}/license`, record)
    await tx.flush()
  }

  async deleteModel (path, source) {
    if (!this.opened) await this.ready()
    const tx = this.db.transaction()
    await tx.delete(`@${QVAC_MAIN_REGISTRY}/model`, { path, source })
    await tx.flush()
  }
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

function parseArgs () {
  const args = process.argv.slice(2)
  const flags = { storage: null, bootstrap: null, dryRun: false, batchSize: DEFAULT_BATCH_SIZE }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--storage':
      case '-s':
        flags.storage = args[++i]
        break
      case '--bootstrap':
      case '-b':
        flags.bootstrap = args[++i]
        break
      case '--dry-run':
        flags.dryRun = true
        break
      case '--batch-size':
        flags.batchSize = parseInt(args[++i], 10)
        break
      default:
        break
    }
  }

  if (!flags.storage) {
    flags.storage = process.env.REGISTRY_STORAGE || './corestore'
  }

  if (!flags.bootstrap) {
    flags.bootstrap = process.env.QVAC_AUTOBASE_KEY || null
  }

  return flags
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  const logger = pino({
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' }
    }
  })

  const flags = parseArgs()

  if (!flags.bootstrap) {
    logger.error('Autobase bootstrap key is required (--bootstrap or QVAC_AUTOBASE_KEY in .env)')
    process.exit(1)
  }

  const autobaseBootstrap = IdEnc.decode(flags.bootstrap)

  logger.info({ storage: flags.storage, dryRun: flags.dryRun, batchSize: flags.batchSize },
    'Migration: backfill models-by-engine-quantization index')

  // --- open corestore ---
  const store = new Corestore(flags.storage)
  await store.ready()

  // --- build apply router with force-insert for put-model ---
  const applyRouter = new Router()
  let forceMode = false // toggled on when we re-append migration ops

  applyRouter.add(DISPATCH_PUT_MODEL, async (model, context) => {
    if (forceMode) {
      await context.view.putModelForce(model)
    } else {
      await context.view.putModel(model)
    }
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

  // --- open autobase ---
  const base = new Autobase(store.namespace(AUTOBASE_NAMESPACE), autobaseBootstrap, {
    open (s) {
      const dbCore = s.get('db-view')
      return new MigrationDatabase(dbCore, { extension: false })
    },
    async apply (nodes, view, b) {
      if (!view.opened) await view.ready()
      for (const node of nodes) {
        await applyRouter.dispatch(node.value, { view, base: b })
      }
      await view.db.flush()
    },
    close (view) {
      return view.close()
    },
    ackInterval: 0
  })

  // We don't join swarm — this is a local-only migration
  await base.ready()

  const view = base.view

  if (!base.isIndexer) {
    logger.error('This storage is not an indexer. Migration must run on an indexer storage.')
    await base.close()
    await store.close()
    process.exit(1)
  }

  logger.info({
    viewKey: IdEnc.normalize(view.core.key),
    viewLength: view.core.length,
    isIndexer: base.isIndexer
  }, 'Autobase opened')

  // --- read all models from the view ---
  if (!view.opened) await view.ready()
  const allModels = await view.db.find(`@${QVAC_MAIN_REGISTRY}/model`, {}).toArray()

  logger.info({ count: allModels.length }, 'Models found in view')

  if (allModels.length === 0) {
    logger.info('No models to migrate')
    await base.close()
    await store.close()
    process.exit(0)
  }

  if (flags.dryRun) {
    logger.info('Dry-run mode — listing models that would be re-indexed:')
    for (const m of allModels) {
      logger.info({ path: m.path, engine: m.engine, quantization: m.quantization, source: m.source })
    }
    logger.info({ count: allModels.length }, 'Dry-run complete — no changes written')
    await base.close()
    await store.close()
    process.exit(0)
  }

  // --- enable force mode and re-append every model ---
  forceMode = true

  let appended = 0
  const total = allModels.length

  for (let i = 0; i < total; i += flags.batchSize) {
    const batch = allModels.slice(i, i + flags.batchSize)
    const ops = batch.map(model => encodeDispatch(DISPATCH_PUT_MODEL, model))

    for (const op of ops) {
      await base.append(op)
      appended++
    }

    logger.info({ appended, total }, 'Progress')
  }

  // Wait for the linearizer to drain — a small flush cycle
  logger.info('Waiting for linearizer to process all operations...')
  await base.view.db.update()

  const viewLengthAfter = view.core.length
  logger.info({ viewLengthBefore: view.core.length - appended, viewLengthAfter, modelsReindexed: appended },
    'Migration complete')

  // --- cleanup ---
  await base.close()
  await store.close()

  logger.info('Done. You can restart the registry server now.')
  process.exit(0)
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})

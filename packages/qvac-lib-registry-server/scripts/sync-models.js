'use strict'

const path = require('path')
const fs = require('fs').promises

const RegistryConfig = require('../lib/config')
const logger = require('../lib/logger')
const { connectToRegistry } = require('./utils/rpc-client')
const { parseCanonicalSource } = require('../lib/source-helpers')
const QVACRegistryClient = require('../client/lib/client')

async function syncModels () {
  const args = process.argv.slice(2)
  const fileArg = args.find(arg => arg.startsWith('--file='))
  const filePath = fileArg ? fileArg.split('=')[1] : './data/models.prod.json'
  const dryRun = args.includes('--dry-run')

  if (dryRun) {
    logger.info('DRY RUN MODE: No changes will be made')
  }

  const config = new RegistryConfig({ logger })
  const registryCoreKey = config.getRegistryCoreKey()

  if (!registryCoreKey) {
    throw new Error('QVAC_REGISTRY_CORE_KEY not set. Run "node scripts/bin.js run" once to initialize keys.')
  }

  // Use client library for reads
  const client = new QVACRegistryClient({ registryCoreKey, logger })
  await client.ready()

  const connection = await connectToRegistry({ config, logger })

  try {
    const configModels = JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'))
    if (!Array.isArray(configModels)) {
      throw new Error(`${filePath} must contain an array of model entries`)
    }

    logger.info(`Loaded ${configModels.length} model(s) from ${filePath}`)

    // Read all models from DB (including deprecated)
    const dbModels = await client.findModels({}, { includeDeprecated: true })
    const dbByKey = new Map()
    for (const model of dbModels) {
      const key = `${model.path}:${model.source}`
      dbByKey.set(key, model)
    }

    logger.info(`Found ${dbModels.length} model(s) in database`)

    const report = { added: [], updated: [], skipped: [], autoDeprecated: [], errors: [] }
    const configKeys = new Set()

    // Process all config entries
    for (const entry of configModels) {
      if (!entry.source) {
        logger.warn('Skipping entry without source', entry)
        continue
      }

      try {
        const sourceInfo = parseCanonicalSource(entry.source)
        const key = `${sourceInfo.path}:${sourceInfo.protocol}`
        configKeys.add(key)
        const existing = dbByKey.get(key)

        if (!existing) {
          report.added.push({ path: sourceInfo.path, source: entry.source })
          if (!dryRun) {
            logger.info(`Adding new model: ${sourceInfo.path}`)
            const modelRequest = {
              source: entry.source,
              engine: entry.engine,
              licenseId: entry.licenseId,
              description: entry.description || '',
              quantization: entry.quantization || '',
              params: entry.params || '',
              notes: entry.notes || '',
              tags: Array.isArray(entry.tags) ? entry.tags : []
            }

            // Include deprecation fields if present
            if (entry.deprecated !== undefined) {
              modelRequest.deprecated = entry.deprecated
            }
            if (entry.deprecatedAt) {
              modelRequest.deprecatedAt = entry.deprecatedAt
            }
            if (entry.replacedBy) {
              modelRequest.replacedBy = entry.replacedBy
            }
            if (entry.deprecationReason) {
              modelRequest.deprecationReason = entry.deprecationReason
            }

            await connection.rpc.request('add-model', modelRequest)
          } else {
            logger.info(`[DRY RUN] Would add: ${sourceInfo.path}`)
          }
        } else if (needsMetadataUpdate(entry, existing, sourceInfo)) {
          const changes = getChanges(entry, existing)
          report.updated.push({ path: sourceInfo.path, changes })
          if (!dryRun) {
            logger.info(`Updating metadata: ${sourceInfo.path}`, { changes })
            const updateRequest = {
              path: sourceInfo.path,
              source: sourceInfo.protocol,
              engine: entry.engine,
              licenseId: entry.licenseId,
              description: entry.description || '',
              quantization: entry.quantization || '',
              params: entry.params || '',
              notes: entry.notes || '',
              tags: Array.isArray(entry.tags) ? entry.tags : []
            }

            // Include deprecation fields
            if (entry.deprecated !== undefined) {
              updateRequest.deprecated = entry.deprecated
            } else if (existing.deprecated) {
              // Un-deprecate: model is in config without deprecated flag but is deprecated in DB
              updateRequest.deprecated = false
              updateRequest.deprecatedAt = ''
              updateRequest.deprecationReason = ''
            }
            if (entry.deprecatedAt) {
              updateRequest.deprecatedAt = entry.deprecatedAt
            } else if (entry.deprecated && !existing.deprecatedAt) {
              // Auto-set deprecatedAt if deprecating for first time
              updateRequest.deprecatedAt = new Date().toISOString()
            }
            if (entry.replacedBy !== undefined) {
              updateRequest.replacedBy = entry.replacedBy || ''
            }
            if (entry.deprecationReason !== undefined) {
              updateRequest.deprecationReason = entry.deprecationReason || ''
            }

            await connection.rpc.request('update-model-metadata', updateRequest)
          } else {
            logger.info(`[DRY RUN] Would update: ${sourceInfo.path}`, { changes })
          }
        } else {
          report.skipped.push({ path: sourceInfo.path })
        }
      } catch (err) {
        let modelPath = 'unknown'
        try {
          const sourceInfo = parseCanonicalSource(entry.source)
          modelPath = sourceInfo.path
        } catch {
          // Ignore parse errors here
        }
        report.errors.push({ path: modelPath, error: err.message })
        logger.error(`Error processing ${entry.source}:`, err.message)
      }
    }

    // Check for orphaned models (in DB but not in config)
    for (const [key, dbModel] of dbByKey) {
      if (!configKeys.has(key) && !dbModel.deprecated) {
        report.autoDeprecated.push({ path: dbModel.path, source: dbModel.source })
        if (!dryRun) {
          logger.info(`Auto-deprecating orphaned model: ${dbModel.path}`)
          await connection.rpc.request('update-model-metadata', {
            path: dbModel.path,
            source: dbModel.source,
            deprecated: true,
            deprecatedAt: new Date().toISOString(),
            deprecationReason: 'Removed from configuration'
          })
        } else {
          logger.info(`[DRY RUN] Would auto-deprecate: ${dbModel.path}`)
        }
      }
    }

    printReport(report, dryRun)
    return report
  } finally {
    await client.close()
    await connection.cleanup()
  }
}

function needsMetadataUpdate (config, existing, sourceInfo) {
  return (
    config.engine !== existing.engine ||
    config.licenseId !== existing.licenseId ||
    (config.description || '') !== (existing.description || '') ||
    (config.quantization || '') !== (existing.quantization || '') ||
    (config.params || '') !== (existing.params || '') ||
    (config.notes || '') !== (existing.notes || '') ||
    JSON.stringify(config.tags || []) !== JSON.stringify(existing.tags || []) ||
    // Un-deprecate: model is deprecated in DB but config doesn't mark it deprecated
    (existing.deprecated && config.deprecated === undefined) ||
    (config.deprecated !== undefined && config.deprecated !== existing.deprecated) ||
    (config.replacedBy !== undefined && config.replacedBy !== (existing.replacedBy || '')) ||
    (config.deprecationReason !== undefined && config.deprecationReason !== (existing.deprecationReason || ''))
  )
}

function getChanges (config, existing) {
  const changes = {}
  if (config.engine !== existing.engine) changes.engine = { from: existing.engine, to: config.engine }
  if (config.licenseId !== existing.licenseId) {
    changes.licenseId = { from: existing.licenseId, to: config.licenseId }
  }
  if ((config.description || '') !== (existing.description || '')) {
    changes.description = { from: existing.description || '', to: config.description || '' }
  }
  if ((config.quantization || '') !== (existing.quantization || '')) {
    changes.quantization = { from: existing.quantization || '', to: config.quantization || '' }
  }
  if ((config.params || '') !== (existing.params || '')) {
    changes.params = { from: existing.params || '', to: config.params || '' }
  }
  if ((config.notes || '') !== (existing.notes || '')) {
    changes.notes = { from: existing.notes || '', to: config.notes || '' }
  }
  if (JSON.stringify(config.tags || []) !== JSON.stringify(existing.tags || [])) {
    changes.tags = { from: existing.tags || [], to: config.tags || [] }
  }
  if (config.deprecated !== undefined && config.deprecated !== existing.deprecated) {
    changes.deprecated = { from: existing.deprecated || false, to: config.deprecated }
  }
  if (config.replacedBy !== undefined && config.replacedBy !== (existing.replacedBy || '')) {
    changes.replacedBy = { from: existing.replacedBy || '', to: config.replacedBy || '' }
  }
  if (config.deprecationReason !== undefined && config.deprecationReason !== (existing.deprecationReason || '')) {
    changes.deprecationReason = { from: existing.deprecationReason || '', to: config.deprecationReason || '' }
  }
  return changes
}

function printReport (report, dryRun) {
  logger.info('\n=== Sync Report ===')
  logger.info(`Added: ${report.added.length}`)
  logger.info(`Updated: ${report.updated.length}`)
  logger.info(`Skipped: ${report.skipped.length}`)
  logger.info(`Auto-deprecated: ${report.autoDeprecated.length}`)
  logger.info(`Errors: ${report.errors.length}`)

  if (report.autoDeprecated.length > 0) {
    logger.info('\nAuto-deprecated models:')
    for (const item of report.autoDeprecated) {
      logger.info(`  - ${item.path} (${item.source})`)
    }
  }

  if (report.errors.length > 0) {
    logger.error('\nErrors:')
    for (const err of report.errors) {
      logger.error(`  ${err.path}: ${err.error}`)
    }
  }

  if (dryRun && (report.added.length > 0 || report.updated.length > 0 || report.autoDeprecated.length > 0)) {
    logger.info('\nRun without --dry-run to apply changes')
  }
}

if (require.main === module) {
  syncModels()
    .then(report => {
      const hasErrors = report && report.errors && report.errors.length > 0
      process.exit(hasErrors ? 1 : 0)
    })
    .catch(err => {
      logger.error('Fatal error during sync-models:', err)
      process.exit(1)
    })
}

module.exports = { syncModels }

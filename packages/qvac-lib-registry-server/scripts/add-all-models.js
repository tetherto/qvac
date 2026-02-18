'use strict'

const path = require('path')
const fs = require('fs').promises
const { command, flag } = require('paparam')

const RegistryConfig = require('../lib/config')
const logger = require('../lib/logger')
const { connectToRegistry } = require('./utils/rpc-client')

const DEFAULT_FILE = './data/models.test.json'

function filterEntriesByRange (entries, fromPattern, untilPattern) {
  let startIdx = 0
  let endIdx = entries.length

  if (fromPattern) {
    const idx = entries.findIndex(e => e.source && e.source.includes(fromPattern))
    if (idx === -1) {
      throw new Error(`--from pattern "${fromPattern}" not found in any model source`)
    }
    startIdx = idx
  }

  if (untilPattern) {
    const idx = entries.findIndex(e => e.source && e.source.includes(untilPattern))
    if (idx === -1) {
      throw new Error(`--until pattern "${untilPattern}" not found in any model source`)
    }
    endIdx = idx
  }

  if (startIdx >= endIdx) {
    throw new Error(`Invalid range: --from index (${startIdx}) >= --until index (${endIdx})`)
  }

  return entries.slice(startIdx, endIdx)
}

async function addAllModels (flags) {
  const storesPath = path.resolve(flags.file)
  let entries = JSON.parse(await fs.readFile(storesPath, 'utf8'))

  if (!Array.isArray(entries)) {
    throw new Error(`${flags.file} must contain an array of entries`)
  }

  const totalCount = entries.length
  entries = filterEntriesByRange(entries, flags.from, flags.until)

  if (flags.limit && flags.limit < entries.length) {
    entries = entries.slice(0, flags.limit)
  }

  logger.info(`Selected ${entries.length} of ${totalCount} models`)
  if (flags.from) logger.info(`  --from: "${flags.from}"`)
  if (flags.until) logger.info(`  --until: "${flags.until}"`)
  if (flags.limit) logger.info(`  --limit: ${flags.limit}`)

  if (flags.dryRun) {
    logger.info('Dry run - models that would be added:')
    entries.forEach((entry, idx) => {
      const shortSource = entry.source.split('/').slice(-1)[0]
      logger.info(`  [${idx + 1}] ${shortSource}`)
    })
    logger.info(`Total: ${entries.length} model(s)`)
    return
  }

  const config = new RegistryConfig({ logger })
  if (flags.storage) {
    logger.info('Using writer storage:', flags.storage)
  }
  const connection = await connectToRegistry({ config, logger, storage: flags.storage, primaryKey: flags.primaryKey })

  try {
    let added = 0
    const failed = []
    for (const entry of entries) {
      if (!entry.source) {
        logger.warn('Skipping entry without source', entry)
        continue
      }

      const payload = {
        source: entry.source,
        engine: entry.engine,
        licenseId: entry.license,
        description: entry.description || '',
        quantization: entry.quantization || '',
        params: entry.params || '',
        notes: entry.notes || '',
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        skipExisting: flags.skipExisting
      }

      logger.info(`Adding model ${entry.source}`)
      if (flags.skipExisting) {
        logger.debug('Skip-existing flag enabled - will skip if model already exists')
      }

      try {
        await connection.rpc.request('add-model', payload)
        added++
      } catch (err) {
        logger.warn(`Failed to add model ${entry.source}: ${err.message}`)
        failed.push(entry.source)
      }
    }

    logger.info(`Completed: ${added} model(s) added, ${failed.length} failed`)
    if (failed.length > 0) {
      logger.warn('Failed model sources:')
      for (const source of failed) {
        logger.warn(`  - ${source}`)
      }
    }
  } finally {
    await connection.cleanup()
  }
}

const cli = command(
  'add-all-models',
  flag('--file|-f [path]', `Models JSON file (default: ${DEFAULT_FILE})`),
  flag('--storage|-s [path]', 'Writer storage path'),
  flag('--primary-key [key]', 'Primary key for corestore'),
  flag('--limit|-l [n]', 'Maximum number of models to add'),
  flag('--from [pattern]', 'Start from model whose source contains this pattern (inclusive)'),
  flag('--until [pattern]', 'Stop before model whose source contains this pattern (exclusive)'),
  flag('--skip-existing', 'Skip models that already exist'),
  flag('--dry-run', 'Show what would be added without making changes'),
  async ({ flags }) => {
    try {
      const opts = {
        file: flags.file || DEFAULT_FILE,
        storage: flags.storage || null,
        primaryKey: flags.primaryKey || null,
        limit: flags.limit ? parseInt(flags.limit, 10) : null,
        from: flags.from || null,
        until: flags.until || null,
        skipExisting: flags.skipExisting || false,
        dryRun: flags.dryRun || false
      }

      if (opts.limit !== null && (isNaN(opts.limit) || opts.limit < 1)) {
        throw new Error('Invalid --limit value. Must be a positive integer.')
      }

      await addAllModels(opts)
    } catch (err) {
      logger.error('Fatal error during add-all-models:', err)
      process.exit(1)
    }
  }
)

if (require.main === module) {
  cli.parse()
}

module.exports = { addAllModels }

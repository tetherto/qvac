'use strict'

const RegistryConfig = require('../lib/config')
const logger = require('../lib/logger')
const { connectToRegistry } = require('./utils/rpc-client')

const EXIT_OK = 0
const EXIT_FATAL = 1
const EXIT_RECORDS_SKIPPED = 2

function parseArgs(args) {
  const options = { filter: null, limit: null, dryRun: false, force: false }
  let storage
  let primaryKey = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filter' || args[i] === '-f') {
      options.filter = args[++i]
    } else if (args[i] === '--limit' || args[i] === '-l') {
      options.limit = Number(args[++i])
    } else if (args[i] === '--dry-run') {
      options.dryRun = true
    } else if (args[i] === '--force') {
      options.force = true
    } else if (args[i] === '--storage') {
      storage = args[++i]
    } else if (args[i] === '--primary-key') {
      primaryKey = args[++i]
    }
  }

  return { options, storage, primaryKey }
}

async function fillFitBlobs() {
  const { options, storage, primaryKey } = parseArgs(process.argv.slice(2))

  if (options.limit !== null && !(Number.isInteger(options.limit) && options.limit > 0)) {
    logger.error('--limit must be a positive integer')
    process.exit(EXIT_FATAL)
  }

  logger.info('Filling fit blobs', options)

  const config = new RegistryConfig({ logger })
  const connection = await connectToRegistry({ config, logger, storage, primaryKey })

  try {
    const { report } = await connection.rpc.request('fill-fit-blobs', options)

    logger.info(`Considered: ${report.considered}`)
    logger.info(`Selected:   ${report.selected}`)
    logger.info(`Filled:     ${report.filled}`)
    logger.info(`Replaced:   ${report.replaced}`)
    logger.info(`Unchanged:  ${report.unchanged}`)
    logger.info(`Downloaded: ${report.downloaded}`)
    logger.info(`Skipped:    ${report.skipped.length}`)

    if (report.paths) {
      for (const path of report.paths) {
        logger.info(`  would fill: ${path}`)
      }
    }

    for (const skip of report.skipped) {
      logger.warn(`  skipped ${skip.path}: ${skip.reason}`)
    }

    return { options, report }
  } catch (err) {
    logger.error('Failed to fill fit blobs:', err)
    throw err
  } finally {
    await connection.cleanup()
  }
}

function exitCodeFor(options, report) {
  if (options.dryRun || report.skipped.length === 0) return EXIT_OK
  return EXIT_RECORDS_SKIPPED
}

function finishRun({ options, report }) {
  const exitCode = exitCodeFor(options, report)
  if (exitCode === EXIT_RECORDS_SKIPPED) {
    logger.error(`${report.skipped.length} of ${report.selected} selected records were not filled`)
  }
  process.exitCode = exitCode
}

if (require.main === module) {
  fillFitBlobs()
    .then(finishRun)
    .catch((err) => {
      logger.error('Fatal error:', err)
      process.exit(EXIT_FATAL)
    })
}

module.exports = { fillFitBlobs, exitCodeFor, EXIT_OK, EXIT_RECORDS_SKIPPED }

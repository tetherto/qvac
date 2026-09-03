import { BatchOrchestrator } from '../../core/batch-orchestrator.js'
import { config as loadDotenv } from 'dotenv'
import * as path from 'node:path'
import { loadConfig } from '../../utils/config-loader.js'
import { loadTests } from '../../utils/test-loader.js'
import { selectTests } from '../../utils/test-selection.js'
import { buildMqttConnectionConfig, createMqttClient } from '../../utils/mqtt-connection.js'

interface ProducerOptions {
  runId?: string
  mqttBroker?: string
  config: string
  consumerTimeout?: string
  consumerInactivityTimeout?: string
  filter?: string
  suite?: string
  excludeSuite?: string
  alsoTests?: string
  reportDir?: string
}

export async function runProducer(options: ProducerOptions) {
  try {
    console.log('🚀 Starting QVAC Test Producer\n')

    const runId = options.runId || `run-${Date.now()}`
    const configDir = path.resolve(options.config)

    // Load .env from config directory (match consumer behavior)
    loadDotenv({ path: path.join(configDir, '.env') })

    console.log(`📂 Loading config from: ${configDir}`)
    const config = await loadConfig(configDir)
    console.log(`✅ Config loaded\n`)

    const mqttConfig = buildMqttConnectionConfig(config)

    if (options.mqttBroker) {
      mqttConfig.brokerUrl = options.mqttBroker
    }

    console.log(`📋 Loading tests from: ${config.testDir}`)
    const catalog = await loadTests(config, configDir)

    if (options.suite) console.log(`🏷️  Including suites: ${options.suite}`)
    if (options.excludeSuite) console.log(`🚫 Excluding suites: ${options.excludeSuite}`)
    if (options.filter) console.log(`🔍 Filtering tests by: ${options.filter}`)

    const selection = selectTests(catalog, options)
    const tests = selection.tests

    if (selection.addedByAlsoTests.length > 0) {
      console.log(
        `➕ Also running ${selection.addedByAlsoTests.length} explicitly requested test(s): ` +
          selection.addedByAlsoTests.join(', ')
      )
    }
    if (selection.unknownAlsoTests.length > 0) {
      console.log(
        `⚠️  ${selection.unknownAlsoTests.length} requested test id(s) are not in the catalog: ` +
          selection.unknownAlsoTests.join(', ')
      )
    }

    if (selection.filtered) {
      console.log(`📋 Filtered: ${tests.length} of ${catalog.length} tests\n`)
    } else {
      console.log(`✅ Loaded ${tests.length} tests\n`)
    }

    const consumerTimeoutSec = parseInt(options.consumerTimeout || '30', 10)
    const consumerInactivityTimeoutSec = parseInt(options.consumerInactivityTimeout || '120', 10)

    const client = createMqttClient(mqttConfig, configDir, { clientId: `producer-${runId}` })
    const reportDir = options.reportDir ? path.resolve(options.reportDir) : undefined
    const orchestrator = new BatchOrchestrator(
      client,
      runId,
      false,
      consumerTimeoutSec,
      consumerInactivityTimeoutSec,
      reportDir
    )

    orchestrator.buildTestQueue(tests)

    setTimeout(() => {
      orchestrator.start()
    }, 1000)

    process.on('SIGINT', () => orchestrator.shutdown())
    process.on('SIGTERM', () => orchestrator.shutdown())
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Failed to start producer:', errorMessage)
    process.exit(1)
  }
}

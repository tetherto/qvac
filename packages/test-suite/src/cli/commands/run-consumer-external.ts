import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../utils/config-loader.js'

interface ExternalConsumerOptions {
  runId: string
  name: string
  config: string
  mqttBroker?: string
}

export async function runConsumerExternal(options: ExternalConsumerOptions) {
  try {
    const config = await loadConfig(options.config)

    const entry = config.consumers.external?.find((c) => c.name === options.name)
    if (!entry) {
      const available = (config.consumers.external ?? []).map((c) => c.name).join(', ') || 'none'
      throw new Error(`No external consumer named "${options.name}" (configured: ${available})`)
    }

    const configDir = path.resolve(options.config)

    console.log(`🚀 Running external consumer "${entry.name}" (${entry.platform})...\n`)

    const __filename = fileURLToPath(import.meta.url)
    const __dirname = path.dirname(__filename)
    const runnerPath = path.resolve(__dirname, '../runners/run-consumer-external-inplace.js')

    const args = [`--runId=${options.runId}`, `--config=${configDir}`, `--name=${options.name}`]
    if (options.mqttBroker) args.push(`--mqtt-broker=${options.mqttBroker}`)

    const child = spawn('node', [runnerPath, ...args], {
      stdio: 'inherit',
      cwd: configDir
    })

    child.on('error', (err) => {
      console.error(`❌ Failed to start external consumer: ${err.message}`)
      process.exit(1)
    })

    process.on('SIGINT', () => child.kill('SIGINT' as never))
    process.on('SIGTERM', () => child.kill('SIGTERM' as never))

    child.on('exit', (code) => {
      process.exit(code || 0)
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Failed to run external consumer:', errorMessage)
    process.exit(1)
  }
}

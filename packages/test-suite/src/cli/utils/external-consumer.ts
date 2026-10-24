import * as path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import type { ExternalConsumerConfig } from '../../types/config.js'
import type { MqttConnectionConfig } from '../../utils/mqtt-connection.js'

/** A command from `consumers.external`, resolved against the config directory. */
interface ExternalCommand {
  interpreter: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

/**
 * What an external client is told about the run. A bridge client never needs it; an mqtt-mode
 * client, or a prepare step that bakes the run into an app, reads it from here.
 */
export function externalRunEnv(
  entry: ExternalConsumerConfig,
  runId: string,
  mqtt: MqttConnectionConfig
): Record<string, string> {
  const env: Record<string, string> = {
    QVAC_RUN_ID: runId,
    QVAC_TEST_PLATFORM: entry.platform,
    QVAC_MQTT_BROKER_URL: mqtt.brokerUrl
  }
  if (mqtt.username) env.QVAC_MQTT_USERNAME = mqtt.username
  if (mqtt.password) env.QVAC_MQTT_PASSWORD = mqtt.password
  if (mqtt.sessionExpiryInterval !== undefined) {
    env.QVAC_MQTT_SESSION_EXPIRY = String(mqtt.sessionExpiryInterval)
  }
  return env
}

function resolveCommand(configDir: string, command: ExternalCommand) {
  // A relative interpreter is relative to the config directory: spawn() resolves the command
  // against the parent's cwd, not the child's.
  const interpreter = /[\\/]/.test(command.interpreter)
    ? path.resolve(configDir, command.interpreter)
    : command.interpreter
  return { interpreter, args: command.args ?? [], cwd: path.resolve(configDir, command.cwd ?? '.') }
}

/** Runs an entry's `prepare` step to completion; throws when it fails. */
export function runExternalPrepare(
  configDir: string,
  entry: ExternalConsumerConfig,
  runEnv: Record<string, string>
): void {
  if (!entry.prepare) return
  const { interpreter, args, cwd } = resolveCommand(configDir, entry.prepare)
  console.log(`🔨 Preparing external consumer "${entry.name}": ${interpreter} ${args.join(' ')}\n`)
  const result = spawnSync(interpreter, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...entry.env, ...entry.prepare.env, ...runEnv }
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`prepare step for "${entry.name}" exited with code ${result.status}`)
  }
}

/**
 * Starts an mqtt-mode client and mirrors its lifetime: its exit code is this process's, and a
 * signal sent here reaches it.
 */
export function runMqttClient(
  configDir: string,
  entry: ExternalConsumerConfig,
  runEnv: Record<string, string>
): void {
  const { interpreter, args, cwd } = resolveCommand(configDir, entry)
  const child = spawn(interpreter, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...entry.env, ...runEnv }
  })
  child.on('error', (err) => {
    console.error(`❌ Failed to start external consumer "${entry.name}": ${err.message}`)
    process.exit(1)
  })
  process.once('SIGINT', () => child.kill('SIGINT'))
  process.once('SIGTERM', () => child.kill('SIGTERM'))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
}

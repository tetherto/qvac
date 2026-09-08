import * as path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../../utils/config-loader.js'
import { snapConsumerSchema } from '../../types/config.js'
import { buildConsumerSnap } from './build-consumer-snap.js'
import { resolveSnapArtifactPath } from '../utils/snap-build-utils.js'
import {
  assertSnapHostPlatform,
  createSnapRuntimeEnv,
  installSnapArtifact,
  resolveSnapRunTarget
} from '../utils/snap-utils.js'

interface ConsumerSnapOptions {
  runId: string
  mqttBroker?: string
  config: string
  skipBuild?: boolean
  skipInstall?: boolean
  skipSnapInstall?: boolean
  mode?: 'consumer' | 'bootstrap'
}

function hasXvfbRun(): boolean {
  const result = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  return !result.error
}

function resolveLaunch(target: string, env: NodeJS.ProcessEnv) {
  const snapArgs = ['run', target]
  if (!env.DISPLAY && env.QVAC_TEST_ELECTRON_XVFB !== '0' && hasXvfbRun()) {
    return {
      command: 'xvfb-run',
      args: ['-a', '--server-args=-screen 0 1280x1024x24', 'snap', ...snapArgs],
      label: `${target} via xvfb-run`
    }
  }

  if (!env.DISPLAY) {
    snapArgs.push('--headless', '--disable-gpu', '--no-sandbox', '--ozone-platform=headless')
  }

  return {
    command: 'snap',
    args: snapArgs,
    label: target
  }
}

export async function runConsumerSnap(options: ConsumerSnapOptions) {
  try {
    assertSnapHostPlatform(process.platform)

    const configDir = path.resolve(options.config)
    loadDotenv({ path: path.join(configDir, '.env') })
    const config = await loadConfig(configDir)

    if (!config.consumers.snap) {
      throw new Error('No Snap consumer configuration found')
    }
    const snap = snapConsumerSchema.parse(config.consumers.snap)

    const env = createSnapRuntimeEnv(process.env, {
      snapName: snap.snapName,
      snapConfigDir: snap.snapConfigDir ?? '.',
      entry: snap.entry,
      runId: options.runId,
      mqttBroker: options.mqttBroker
    })
    env.QVAC_TEST_MODE = options.mode ?? 'consumer'

    const appDir = path.resolve(configDir, snap.appDir)
    let artifactPath: string | undefined
    if (!options.skipBuild) {
      artifactPath = await buildConsumerSnap({
        config: configDir,
        skipInstall: options.skipInstall
      })
    } else if (!options.skipSnapInstall) {
      artifactPath = resolveSnapArtifactPath(appDir, snap.artifactPath)
    }

    if (!options.skipSnapInstall) {
      if (!artifactPath) {
        throw new Error('Snap artifact is required when installation is enabled')
      }
      console.log(`📥 Installing Snap consumer: ${artifactPath}\n`)
      installSnapArtifact(artifactPath)
    }

    const target = resolveSnapRunTarget(snap.snapName, snap.appCommand)
    const launch = resolveLaunch(target, env)
    console.log(`🚀 Launching Snap consumer: ${launch.label}\n`)

    const child = spawn(launch.command, launch.args, {
      cwd: appDir,
      env,
      stdio: 'inherit'
    })

    child.on('error', (error) => {
      console.error(`❌ Failed to start Snap consumer: ${error.message}`)
      process.exit(1)
    })

    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))

    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`❌ Snap consumer terminated by signal ${signal}`)
      }
      process.exit(signal ? 1 : (code ?? 1))
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`❌ Failed to run Snap consumer: ${errorMessage}`)
    process.exit(1)
  }
}

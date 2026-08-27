import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../../utils/config-loader.js'
import { buildConsumerElectron } from './build-consumer-electron.js'
import { toForgePlatform } from '../utils/electron-utils.js'

interface ConsumerElectronOptions {
  runId: string
  mqttBroker?: string
  config: string
  platform?: string
  arch?: string
  skipBuild?: boolean
  skipInstall?: boolean
}

function readPackageAppName(appDir: string): string {
  const packageJsonPath = path.join(appDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    name?: string
    productName?: string
  }
  const appName = packageJson.productName || packageJson.name
  if (!appName) {
    throw new Error(`Electron app package.json must define name or productName: ${packageJsonPath}`)
  }
  return appName
}

function findFile(
  root: string,
  predicate: (filePath: string) => boolean,
  maxDepth: number = 5
): string | undefined {
  if (!fs.existsSync(root)) return undefined

  function visit(dir: string, depth: number): string | undefined {
    if (depth > maxDepth) return undefined
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = visit(fullPath, depth + 1)
        if (found) return found
      } else if (predicate(fullPath)) {
        return fullPath
      }
    }
    return undefined
  }

  return visit(root, 0)
}

function resolvePackagedExecutable(
  appDir: string,
  outDir: string,
  appName: string,
  platform: NodeJS.Platform,
  arch: string
) {
  const outRoot = path.resolve(appDir, outDir)
  const expectedDir = path.join(outRoot, `${appName}-${platform}-${arch}`)

  if (!fs.existsSync(expectedDir)) {
    throw new Error(`Packaged Electron output not found for ${platform}-${arch}: ${expectedDir}`)
  }

  if (platform === 'darwin') {
    const expected = path.join(expectedDir, `${appName}.app`, 'Contents', 'MacOS', appName)
    if (fs.existsSync(expected)) return expected

    const found = findFile(expectedDir, (filePath) => filePath.includes('.app/Contents/MacOS/'))
    if (found) return found
  }

  if (platform === 'win32') {
    const expected = path.join(expectedDir, `${appName}.exe`)
    if (fs.existsSync(expected)) return expected

    const found = findFile(expectedDir, (filePath) => filePath.endsWith('.exe'))
    if (found) return found
  }

  if (platform === 'linux') {
    const expected = path.join(expectedDir, appName)
    if (fs.existsSync(expected)) return expected

    const found = findFile(expectedDir, (filePath) => path.basename(filePath) === appName)
    if (found) return found
  }

  throw new Error(`Could not find packaged Electron executable under ${expectedDir}`)
}

function needsVirtualDisplay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && !env.DISPLAY && env.QVAC_TEST_ELECTRON_XVFB !== '0'
}

function hasXvfbRun(): boolean {
  const result = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  return !result.error
}

function resolveLaunchCommand(
  executable: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
) {
  if (needsVirtualDisplay(platform, env)) {
    if (!hasXvfbRun()) {
      return {
        command: executable,
        args: ['--headless', '--disable-gpu', '--no-sandbox', '--ozone-platform=headless'],
        label: `${executable} (headless ozone)`
      }
    }

    return {
      command: 'xvfb-run',
      args: ['-a', '--server-args=-screen 0 1280x1024x24', executable],
      label: `${executable} (via xvfb-run)`
    }
  }

  return {
    command: executable,
    args: [],
    label: executable
  }
}

export async function runConsumerElectron(options: ConsumerElectronOptions) {
  try {
    const configDir = path.resolve(options.config)
    loadDotenv({ path: path.join(configDir, '.env') })

    const config = await loadConfig(configDir)
    const electron = config.consumers.electron

    if (!electron) {
      throw new Error('No electron consumer configuration found')
    }

    const appDir = path.resolve(configDir, electron.appDir)
    const appName = electron.appName || readPackageAppName(appDir)
    const platform = toForgePlatform(options.platform)
    const arch = options.arch || process.arch
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      QVAC_TEST_RUN_ID: options.runId,
      QVAC_TEST_CONFIG_DIR: configDir,
      QVAC_TEST_CONSUMER_ENTRY: path.resolve(configDir, electron.entry),
      QVAC_TEST_PLATFORM: 'electron'
    }

    if (options.mqttBroker) {
      env.QVAC_TEST_MQTT_BROKER = options.mqttBroker
    }

    if (!options.skipBuild) {
      await buildConsumerElectron({
        config: configDir,
        platform,
        arch,
        skipInstall: options.skipInstall
      })
    }

    const executable = resolvePackagedExecutable(
      appDir,
      electron.outDir ?? 'out',
      appName,
      platform,
      arch
    )
    const launch = resolveLaunchCommand(executable, platform, env)

    if (launch.command === 'xvfb-run') {
      console.log('🖥️  No DISPLAY detected; launching Electron with xvfb-run')
    } else if (needsVirtualDisplay(platform, env)) {
      console.log(
        '🖥️  No DISPLAY or xvfb-run detected; launching Electron with headless Ozone flags'
      )
    }
    console.log(`🚀 Launching Electron consumer: ${launch.label}\n`)

    const child = spawn(launch.command, launch.args, {
      cwd: appDir,
      env,
      stdio: 'inherit'
    })

    child.on('error', (err) => {
      console.error(`❌ Failed to start Electron consumer: ${err.message}`)
      process.exit(1)
    })

    process.on('SIGINT', () => child.kill('SIGINT'))
    process.on('SIGTERM', () => child.kill('SIGTERM'))

    child.on('exit', (code) => {
      process.exit(code || 0)
    })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error('❌ Failed to run Electron consumer:', errorMessage)
    process.exit(1)
  }
}

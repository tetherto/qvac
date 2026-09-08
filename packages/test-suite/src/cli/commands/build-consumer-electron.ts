import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../../utils/config-loader.js'
import { toForgePlatform } from '../utils/electron-utils.js'

interface BuildConsumerElectronOptions {
  config: string
  platform?: string
  arch?: string
  skipInstall?: boolean
}

function installArgs(packageManager: string): string[] {
  if (packageManager === 'npm') return ['install', '--install-links']
  return ['install']
}

function runArgs(
  packageManager: string,
  script: string,
  platform: NodeJS.Platform,
  arch: string
): string[] {
  const forwarded = [`--platform=${platform}`, `--arch=${arch}`]
  if (packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
    return ['run', script, '--', ...forwarded]
  }
  return ['run', script, ...forwarded]
}

function createElectronBuildEnv(platform: NodeJS.Platform, arch: string): NodeJS.ProcessEnv {
  const tempRoot = process.env.QVAC_TEST_ELECTRON_TMPDIR || process.env.RUNNER_TEMP || os.tmpdir()
  fs.mkdirSync(tempRoot, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(tempRoot, `qvac-electron-${platform}-${arch}-`))

  return {
    ...process.env,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir
  }
}

function runPackageManager(
  packageManager: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): void {
  execFileSync(packageManager, args, {
    cwd,
    stdio: 'inherit',
    env,
    // On Windows, npm/pnpm/yarn are command shims. Running through the shell lets
    // Node resolve npm.cmd/pnpm.cmd/yarn.cmd instead of failing with ENOENT.
    shell: process.platform === 'win32'
  })
}

export async function buildConsumerElectron(options: BuildConsumerElectronOptions) {
  const configDir = path.resolve(options.config)
  loadDotenv({ path: path.join(configDir, '.env') })

  const config = await loadConfig(configDir)
  const electron = config.consumers.electron

  if (!electron) {
    throw new Error('No electron consumer configuration found')
  }

  const appDir = path.resolve(configDir, electron.appDir)
  const packageManager = electron.packageManager ?? 'npm'
  const packageScript = electron.packageScript ?? 'package'
  const platform = toForgePlatform(options.platform)
  const arch = options.arch || process.arch
  const buildEnv = createElectronBuildEnv(platform, arch)

  console.log('⚡ Building Electron consumer...\n')
  console.log(`📂 App: ${appDir}`)
  console.log(`🎯 Target: ${platform}-${arch}`)

  if (!options.skipInstall) {
    console.log(`\n📦 Installing Electron app dependencies with ${packageManager}...`)
    runPackageManager(packageManager, installArgs(packageManager), appDir, buildEnv)
  }

  console.log(`\n🏗️  Running ${packageManager} run ${packageScript}...`)
  runPackageManager(
    packageManager,
    runArgs(packageManager, packageScript, platform, arch),
    appDir,
    buildEnv
  )

  console.log('\n✅ Electron consumer packaged')
}

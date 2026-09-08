import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'
import { loadConfig } from '../../utils/config-loader.js'
import { snapConsumerSchema } from '../../types/config.js'
import { assertSnapHostPlatform } from '../utils/snap-utils.js'
import {
  resolveSnapArtifactOutputPath,
  resolveSnapArtifactPath
} from '../utils/snap-build-utils.js'

interface BuildConsumerSnapOptions {
  config: string
  skipInstall?: boolean
}

function runPackageManager(packageManager: string, args: string[], cwd: string): void {
  execFileSync(packageManager, args, {
    cwd,
    stdio: 'inherit',
    env: process.env
  })
}

function installArgs(packageManager: string): string[] {
  return packageManager === 'npm' ? ['install', '--install-links'] : ['install']
}

export async function buildConsumerSnap(options: BuildConsumerSnapOptions): Promise<string> {
  assertSnapHostPlatform(process.platform)

  const configDir = path.resolve(options.config)
  loadDotenv({ path: path.join(configDir, '.env') })
  const config = await loadConfig(configDir)

  if (!config.consumers.snap) {
    throw new Error('No Snap consumer configuration found')
  }
  const snap = snapConsumerSchema.parse(config.consumers.snap)

  const appDir = path.resolve(configDir, snap.appDir)
  const packageManager = snap.packageManager ?? 'npm'
  const packageScript = snap.packageScript ?? 'package:snap'
  const artifactPath = resolveSnapArtifactOutputPath(appDir, snap.artifactPath)

  console.log('📦 Building Snap consumer...\n')
  console.log(`📂 App: ${appDir}`)
  console.log(`📛 Snap: ${snap.snapName}`)

  fs.rmSync(artifactPath, { force: true })
  if (!options.skipInstall) {
    console.log(`\n📦 Installing Snap app dependencies with ${packageManager}...`)
    runPackageManager(packageManager, installArgs(packageManager), appDir)
  }

  console.log(`\n🏗️  Running ${packageManager} run ${packageScript}...`)
  try {
    runPackageManager(packageManager, ['run', packageScript], appDir)
  } catch (error) {
    try {
      const failedArtifactPath = resolveSnapArtifactOutputPath(appDir, snap.artifactPath)
      fs.rmSync(failedArtifactPath, { force: true })
    } catch {}
    throw error
  }

  const builtArtifactPath = resolveSnapArtifactPath(appDir, snap.artifactPath)
  console.log(`\n✅ Snap consumer packaged: ${builtArtifactPath}`)
  return builtArtifactPath
}

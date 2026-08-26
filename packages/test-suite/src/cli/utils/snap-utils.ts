import * as path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

interface SnapRuntimeOptions {
  snapName: string
  snapConfigDir: string
  entry: string
  runId: string
  mqttBroker?: string
}

export function assertSnapHostPlatform(platform: NodeJS.Platform): void {
  if (platform !== 'linux') {
    throw new Error(`Snap consumers require Linux; current platform is ${platform}`)
  }
}

export function runSnapAdmin(args: string[]): void {
  if (process.env.QVAC_TEST_SNAP_SUDO === '0') {
    execFileSync('snap', args, { stdio: 'inherit' })
    return
  }
  execFileSync('sudo', ['snap', ...args], { stdio: 'inherit' })
}

export function isSnapInstalled(snapName: string): boolean {
  const result = spawnSync('snap', ['list', snapName], { encoding: 'utf8' })
  if (result.status === 0) {
    return true
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (/no matching snaps installed/i.test(output)) {
    return false
  }

  const detail = result.error?.message ?? (output || `exit code ${result.status ?? 'unknown'}`)
  throw new Error(`Unable to determine whether Snap ${snapName} is installed: ${detail}`)
}

export function installSnapArtifact(artifactPath: string): void {
  // snap install treats another local revision of an installed Snap as a refresh.
  runSnapAdmin(['install', '--dangerous', artifactPath])
}

export function resolveSnapRunTarget(snapName: string, appCommand: string): string {
  return appCommand === snapName ? snapName : `${snapName}.${appCommand}`
}

export function resolveSnapMountedPath(snapName: string, relativePath: string): string {
  const normalized = path.posix.normalize(relativePath)
  if (path.posix.isAbsolute(relativePath) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path must stay inside the Snap mount: ${relativePath}`)
  }

  return path.posix.join('/snap', snapName, 'current', normalized)
}

export function createSnapRuntimeEnv(
  baseEnv: Readonly<NodeJS.ProcessEnv>,
  options: SnapRuntimeOptions
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    QVAC_TEST_RUN_ID: options.runId,
    QVAC_TEST_CONFIG_DIR: resolveSnapMountedPath(options.snapName, options.snapConfigDir),
    QVAC_TEST_CONSUMER_ENTRY: resolveSnapMountedPath(options.snapName, options.entry),
    QVAC_TEST_PLATFORM: 'snap-linux'
  }

  if (options.mqttBroker) {
    env.QVAC_TEST_MQTT_BROKER = options.mqttBroker
  }

  delete env.QVAC_CONFIG_PATH
  return env
}

import { spawnSync } from 'node:child_process'
import { posix, resolve } from 'node:path'
import config from '../qvac-test.config.js'

const snapConfig = config.consumers.snap
const SNAP_NAME = snapConfig.snapName

function resolveMountedPath(relativePath) {
  const normalized = posix.normalize(relativePath)
  if (posix.isAbsolute(relativePath) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Path must stay inside the Snap mount: ${relativePath}`)
  }
  return posix.join('/snap', SNAP_NAME, 'current', normalized)
}

const SNAP_ENTRY = resolveMountedPath(snapConfig.entry)
const SNAP_CONFIG_DIR = resolveMountedPath(snapConfig.snapConfigDir)

function readOption(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    env: options.env ?? process.env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`)
  }
}

function runSnapAdmin(args) {
  if (process.env.QVAC_TEST_SNAP_SUDO === '0') {
    run('snap', args)
    return
  }
  run('sudo', ['snap', ...args])
}

function hasXvfbRun() {
  const result = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  return !result.error
}

function isSnapInstalled() {
  const result = spawnSync('snap', ['list', SNAP_NAME], { stdio: 'ignore' })
  return !result.error && result.status === 0
}

function runProbe(phase) {
  const env = {
    ...process.env,
    QVAC_TEST_MODE: 'storage-probe',
    QVAC_TEST_PLATFORM: 'snap-linux',
    QVAC_TEST_RUN_ID: `snap-refresh-${phase}`,
    QVAC_TEST_CONFIG_DIR: SNAP_CONFIG_DIR,
    QVAC_TEST_CONSUMER_ENTRY: SNAP_ENTRY,
    QVAC_TEST_SNAP_PROBE_PHASE: phase
  }
  delete env.QVAC_CONFIG_PATH

  if (!env.DISPLAY && hasXvfbRun()) {
    run('xvfb-run', ['-a', '--server-args=-screen 0 1280x1024x24', 'snap', 'run', SNAP_NAME], {
      env
    })
    return
  }

  const args = ['run', SNAP_NAME]
  if (!env.DISPLAY) {
    args.push('--headless', '--disable-gpu', '--no-sandbox', '--ozone-platform=headless')
  }
  run('snap', args, { env })
}

const firstArtifact = readOption('--first')
const secondArtifact = readOption('--second')
if (!firstArtifact || !secondArtifact) {
  throw new Error('Usage: run-snap-refresh-test.mjs --first <first.snap> --second <second.snap>')
}

try {
  if (isSnapInstalled()) {
    runSnapAdmin(['remove', '--purge', SNAP_NAME])
  }
  runSnapAdmin(['install', '--dangerous', resolve(firstArtifact)])
  runProbe('before')
  // Installing another local revision of the same Snap is treated as a refresh.
  runSnapAdmin(['install', '--dangerous', resolve(secondArtifact)])
  runProbe('after')
} finally {
  if (process.env.QVAC_TEST_SNAP_KEEP_INSTALLED !== '1') {
    try {
      runSnapAdmin(['remove', '--purge', SNAP_NAME])
    } catch (error) {
      console.warn(`Failed to remove ${SNAP_NAME}: ${String(error)}`)
    }
  }
}

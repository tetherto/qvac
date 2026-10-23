import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import config from '../qvac-test.config.js'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(scriptDir, '..')
const snapConfig = config.consumers.snap
const electronConfig = config.consumers.electron
const snapDir = join(projectDir, 'snap')
const electronDist = join(snapDir, 'electron-dist')
const packagedSnapApp = join(electronDist, 'app')
const packagedBareBinary = join(
  packagedSnapApp,
  'resources',
  'app',
  'node_modules',
  `bare-runtime-linux-${process.arch}`,
  'bin',
  'bare'
)
const stableArtifact = resolve(projectDir, snapConfig.artifactPath)
const artifactDir = dirname(stableArtifact)
const electronOutput = join(projectDir, 'out', `${electronConfig.appName}-linux-${process.arch}`)
const snapBuildMode = process.env.QVAC_TEST_SNAP_BUILD_MODE ?? 'lxd'

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`)
  }
}

if (process.platform !== 'linux') {
  throw new Error(`Snap packaging requires Linux; current platform is ${process.platform}`)
}

rmSync(electronDist, { recursive: true, force: true })

run(
  'npm',
  ['run', 'package:electron', '--', '--platform=linux', `--arch=${process.arch}`],
  projectDir
)

mkdirSync(electronDist, { recursive: true })
cpSync(electronOutput, packagedSnapApp, { recursive: true })
// bare-runtime normally repairs this mode at startup, but a mounted Snap is read-only.
chmodSync(packagedBareBinary, 0o755)
writeFileSync(
  join(electronDist, 'qvac-snap-build-id'),
  `${process.env.QVAC_TEST_SNAP_BUILD_ID ?? Date.now()}\n`
)

for (const fileName of readdirSync(snapDir)) {
  if (fileName.endsWith('.snap')) rmSync(join(snapDir, fileName), { force: true })
}

if (snapBuildMode === 'lxd') {
  run('snapcraft', ['--use-lxd'], snapDir)
} else if (snapBuildMode === 'destructive') {
  run('sudo', ['snapcraft', '--destructive-mode'], snapDir)
} else {
  throw new Error(`Unsupported QVAC_TEST_SNAP_BUILD_MODE: ${snapBuildMode}`)
}

const builtArtifact = readdirSync(snapDir).find((fileName) => fileName.endsWith('.snap'))
if (!builtArtifact) {
  throw new Error(`Snapcraft did not produce a .snap artifact in ${snapDir}`)
}

mkdirSync(artifactDir, { recursive: true })
rmSync(stableArtifact, { force: true })
cpSync(join(snapDir, builtArtifact), stableArtifact)
console.log(`Snap artifact: ${stableArtifact}`)

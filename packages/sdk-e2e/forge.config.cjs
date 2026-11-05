'use strict'

const fs = require('node:fs')
const path = require('node:path')
const QvacForgePlugin = require('@qvac/sdk/electron-forge')

const projectDir = __dirname
const electronConfigPath = path.join(projectDir, 'fixtures', 'qvac.config.electron.json')
const runtimeConfigPath = path.join(projectDir, 'qvac.config.json')
const generatedWorkerDir = path.join(projectDir, 'qvac')
const backupDir = path.join(projectDir, '.qvac-worker-backup')
const backupWorkerDir = path.join(backupDir, 'qvac')
const backupConfigPath = path.join(backupDir, 'qvac.config.json')

// Electron overwrites the shared worker bundle to package its own. Snapshot it first and
// restore it after, so desktop/Electron runs don't clobber each other's bundle locally.
// Skip if a backup already exists — a previous run left it there without restoring it.
function snapshotExistingWorker() {
  if (fs.existsSync(backupDir)) return
  if (!fs.existsSync(generatedWorkerDir) && !fs.existsSync(runtimeConfigPath)) return

  fs.mkdirSync(backupDir, { recursive: true })
  if (fs.existsSync(generatedWorkerDir)) {
    fs.cpSync(generatedWorkerDir, backupWorkerDir, { recursive: true })
  }
  if (fs.existsSync(runtimeConfigPath)) {
    fs.copyFileSync(runtimeConfigPath, backupConfigPath)
  }
}

function restorePreviousWorker() {
  fs.rmSync(generatedWorkerDir, { recursive: true, force: true })
  fs.rmSync(runtimeConfigPath, { force: true })

  if (fs.existsSync(backupWorkerDir)) {
    fs.cpSync(backupWorkerDir, generatedWorkerDir, { recursive: true })
  }
  if (fs.existsSync(backupConfigPath)) {
    fs.copyFileSync(backupConfigPath, runtimeConfigPath)
  }
  fs.rmSync(backupDir, { recursive: true, force: true })
}

function ensureRuntimeConfig() {
  fs.copyFileSync(electronConfigPath, runtimeConfigPath)
}

// postPackage doesn't fire on interrupt/crash, so also restore on exit/SIGINT/SIGTERM.
// Idempotent — a no-op if postPackage already restored (and removed backupDir).
let restored = false
function restoreOnce() {
  if (restored) return
  restored = true
  restorePreviousWorker()
}
process.once('exit', restoreOnce)
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143]
]) {
  process.once(signal, () => {
    restoreOnce()
    process.exit(exitCode)
  })
}

snapshotExistingWorker()
ensureRuntimeConfig()

module.exports = {
  packagerConfig: {
    name: 'QVACSDKElectronE2E',
    asar: false,
    ignore: [
      /^\/build\//, // mobile Pods/Gradle output — breaks packager on xcframework code-signature files
      /^\/reports\//, // test run reports
      /^\/\.env$/, // MQTT creds — read by the CLI orchestrator, not the packaged app
      /^\/\.env\.bak-/, // env backups
      /^\/\.npmrc$/, // registry credentials — required only while installing host dependencies
      /^\/snap\//, // Snapcraft outputs — never recursively package previous revisions
      /^\/\.qvac-worker-backup\// // desktop worker snapshot, restored in postPackage
    ]
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    postPackage: async () => {
      restoreOnce()
    }
  },
  plugins: [
    new QvacForgePlugin({
      projectDir,
      configPath: electronConfigPath,
      logLevel: 'debug'
    })
  ]
}

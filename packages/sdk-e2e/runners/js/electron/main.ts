import { app } from 'electron'
import { pathToFileURL } from 'node:url'

app.commandLine.appendSwitch('no-sandbox')

async function startConfiguredConsumer() {
  const entryPath = process.env['QVAC_TEST_CONSUMER_ENTRY']
  const configDir = process.env['QVAC_TEST_CONFIG_DIR']
  if (!entryPath) {
    throw new Error('QVAC_TEST_CONSUMER_ENTRY is required')
  }
  if (!configDir) {
    throw new Error('QVAC_TEST_CONFIG_DIR is required')
  }

  // Strict Snap may inherit a host checkout cwd that is outside confinement.
  // Use the packaged config root so existing Electron asset resolution remains unchanged.
  process.chdir(configDir)

  const entry = (await import(pathToFileURL(entryPath).href)) as {
    startElectronConsumer?: () => Promise<void>
    bootstrap?: () => Promise<void>
    runSnapRefreshProbe?: () => Promise<void>
  }

  if (process.env['QVAC_TEST_MODE'] === 'storage-probe') {
    if (typeof entry.runSnapRefreshProbe !== 'function') {
      throw new Error(`Electron consumer entry must export runSnapRefreshProbe(): ${entryPath}`)
    }
    await entry.runSnapRefreshProbe()
    app.quit()
    return
  }

  if (process.env['QVAC_TEST_MODE'] === 'bootstrap') {
    if (typeof entry.bootstrap !== 'function') {
      throw new Error(`Electron consumer entry must export bootstrap(): ${entryPath}`)
    }
    await entry.bootstrap()
    app.quit()
    return
  }

  if (typeof entry.startElectronConsumer !== 'function') {
    throw new Error(`Electron consumer entry must export startElectronConsumer(): ${entryPath}`)
  }

  await entry.startElectronConsumer()
}

app
  .whenReady()
  .then(async () => {
    console.log('[electron-e2e] app ready')
    await startConfiguredConsumer()
  })
  .catch((error: unknown) => {
    console.error('[electron-e2e] failed to start:', error)
    app.exit(1)
  })

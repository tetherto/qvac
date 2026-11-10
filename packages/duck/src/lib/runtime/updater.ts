import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import PearRuntimeUpdater from 'pear-runtime-updater'

export async function startUpdater(entries: { release: string } | null = null) {
  const manifest = entries
    ? new URL(entries.release)
    : new URL('../../../package.json', import.meta.url)
  const { version, upgrade } = JSON.parse(fs.readFileSync(fileURLToPath(manifest.href), 'utf8'))
  if (!upgrade) {
    return null
  }

  const dir = appDir()
  fs.mkdirSync(dir, { recursive: true })

  const { default: LockFile } = await import('fs-native-lock')
  const lock = new LockFile(path.join(dir, 'qvac-cli.lock'))
  try {
    await lock.lock()
  } catch {
    return null
  }

  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  const swarm = new Hyperswarm()
  swarm.on('connection', (connection) => store.replicate(connection))

  const updater = new PearRuntimeUpdater({
    dir,
    store,
    version,
    upgrade,
    app: os.execPath(),
    name: os.platform() === 'win32' ? 'qvac.exe' : 'qvac'
  })
  updater.on('error', () => {})

  const close = async () => {
    await swarm.destroy()
    await updater.close()
    await store.close()
    await lock.unlock()
  }

  try {
    await updater.ready()
  } catch (err) {
    await close()
    throw err
  }

  swarm.join(updater.drive.core.discoveryKey)

  return { updater, close }
}

function appDir() {
  const home = os.homedir()
  switch (os.platform()) {
    case 'win32':
      return path.join(home, 'AppData', 'Roaming', 'qvac-cli')
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'qvac-cli')
    default:
      return path.join(home, '.config', 'qvac-cli')
  }
}

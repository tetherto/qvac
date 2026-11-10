import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import PearRuntimeUpdater from 'pear-runtime-updater'

// the binary, which names its app directory, lock and download directory too
const name = 'qvac'

export async function startUpdater(entries: { release: string }) {
  const { version, upgrade } = JSON.parse(fs.readFileSync(fileURLToPath(entries.release), 'utf8'))
  if (!upgrade) {
    return null
  }

  const dir = appDir()
  fs.mkdirSync(dir, { recursive: true })

  const { default: LockFile } = await import('fs-native-lock')
  const lock = new LockFile(path.join(dir, `${name}.lock`))
  try {
    await lock.lock()
  } catch {
    return null
  }

  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  const swarm = new Hyperswarm()
  swarm.on('connection', (connection) => store.replicate(connection))

  const app = os.execPath()
  const updater = new PearRuntimeUpdater({
    // the next build is swapped in by rename, so it downloads onto the executable's own volume
    dir: path.join(path.dirname(app), `.${name}-update`),
    store,
    version,
    upgrade,
    app,
    name: os.platform() === 'win32' ? `${name}.exe` : name
  })
  updater.on('error', () => {})

  // updater.close() waits out a download that can no longer finish once the swarm is gone
  const close = async () => {
    await swarm.destroy()
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
      return path.join(home, 'AppData', 'Roaming', name)
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', name)
    default:
      return path.join(home, '.config', name)
  }
}

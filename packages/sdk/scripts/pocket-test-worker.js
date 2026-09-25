// Bare bootstrap for the real worker process spawned by the Node SDK client.
import Module from 'bare-module'
import path from 'bare-path'
import fs from 'bare-fs'
import env from 'bare-env'
import { fileURLToPath, pathToFileURL } from 'bare-url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = env['QVAC_POCKET_TEST_HOME']
if (!home) throw new Error('QVAC_POCKET_TEST_HOME is required for isolated IPC validation')
const config = JSON.parse(Bare.argv[2])
config.HOME_DIR = home
Bare.argv[2] = JSON.stringify(config)
const imports = JSON.parse(fs.readFileSync(path.join(root, 'bare-imports.json'), 'utf8'))
Module.load(pathToFileURL(path.join(root, 'scripts/pocket-worker-entry.js')), null, {
  imports,
  conditions: ['bare', 'import']
})

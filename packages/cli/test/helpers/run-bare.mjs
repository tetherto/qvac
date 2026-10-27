import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const manifest = process.env.QVAC_CLI_TEST_PACKAGE
  ? pathToFileURL(path.resolve(process.env.QVAC_CLI_TEST_PACKAGE, 'package.json'))
  : import.meta.url
const require = createRequire(manifest),
  binary = require('bare-runtime')()
if (process.platform !== 'win32') {
  fs.chmodSync(binary, 0o755)
}

const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))

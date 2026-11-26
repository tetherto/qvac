// Copies the generated src/db/hyperspec, which tsc skips, into the build
// output named by the last CLI arg (`dist` or `test/dist/src`).
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const destRoot = process.argv[process.argv.length - 1]

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url))
const packageRoot = path.join(scriptDir, '..')
const hyperspecDir = path.join('db', 'hyperspec')

fs.cpSync(
  path.join(packageRoot, 'src', hyperspecDir),
  path.join(packageRoot, destRoot, hyperspecDir),
  {
    recursive: true
  }
)

// Integration tests read data fixtures (e.g. sample.txt) relative to the
// compiled test file under test/dist. tsc only emits the .js, so copy the
// non-TypeScript fixtures from test/integration next to the compiled tests.
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'

const scriptDir = path.dirname(url.fileURLToPath(import.meta.url))
const packageRoot = path.join(scriptDir, '..')
const sourceDir = path.join(packageRoot, 'test', 'integration')
const destDir = path.join(packageRoot, 'test', 'dist', 'test', 'integration')

for (const entry of fs.readdirSync(sourceDir)) {
  if (entry.endsWith('.ts')) continue
  fs.cpSync(path.join(sourceDir, entry), path.join(destDir, entry), { recursive: true })
}

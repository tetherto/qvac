// The HyperDB spec under src/adapters/database/hyperspec is generated JS+JSON
// (see build-hyperdb-spec.ts) and is excluded from the TypeScript build. Copy it
// verbatim next to the compiled HyperDBAdapter so it can import the spec at
// runtime. The destination root (relative to the package) is the last CLI arg:
// `dist` for the package build, `test/dist/src` for the test build.
import fs from 'bare-fs'
import path from 'bare-path'

const destRoot = Bare.argv[Bare.argv.length - 1]

const scriptDir = path.dirname(new URL(import.meta.url).pathname)
const packageRoot = path.join(scriptDir, '..')
const hyperspecDir = path.join('adapters', 'database', 'hyperspec')

fs.cpSync(
  path.join(packageRoot, 'src', hyperspecDir),
  path.join(packageRoot, destRoot, hyperspecDir),
  {
    recursive: true
  }
)

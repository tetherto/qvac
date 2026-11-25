import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const inferenceBrowser = join(dirname(require.resolve('@qvac/inference/package')), 'dist/browser')

const externalizeEngines = {
  name: 'llm-llamacpp-web-engines',
  setup(builder) {
    builder.onResolve({ filter: /prebuilds\/web\/llm-llamacpp(-64)?\.mjs$/ }, (args) => ({
      path: `@qvac/llm-llamacpp/prebuilds/web/${args.path.split('/').pop()}`,
      external: true
    }))
  }
}

await build({
  entryPoints: [join(root, 'dist/src/worker/browser.js')],
  outfile: join(root, 'dist/worker.browser.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser'],
  alias: { 'bare-os': join(inferenceBrowser, 'os.js') },
  plugins: [externalizeEngines],
  logLevel: 'warning'
})

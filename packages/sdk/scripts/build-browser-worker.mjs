// Prebuilds the browser worker (dist/src/worker/browser.js and everything it
// imports) into dist/worker.browser.js, so browser apps need no bundler
// configuration for Bare modules. Packages with a browser build declare their
// substitutions in their package.json `browser` field; the alias below covers
// a transitive dependency that does not.
//
// The LLM addon's WebAssembly module stays external, imported from
// @qvac/llm-llamacpp, so the app's bundler emits it and its .wasm as assets
// instead of the SDK shipping a copy.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const inferenceBrowser = join(dirname(require.resolve('@qvac/inference/package')), 'dist/browser')

const llmWebModule = {
  name: 'llm-llamacpp-web-module',
  setup(builder) {
    builder.onResolve({ filter: /prebuilds\/web\/llm-llamacpp\.mjs$/ }, () => ({
      path: '@qvac/llm-llamacpp/prebuilds/web/llm-llamacpp.mjs',
      external: true
    }))
  }
}

await build({
  entryPoints: [join(root, 'dist/src/worker/browser.js')],
  outfile: join(root, 'dist/worker.browser.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser'],
  // @qvac/infer-base (via @qvac/llm-llamacpp) reads the platform from bare-os.
  alias: { 'bare-os': join(inferenceBrowser, 'os.js') },
  plugins: [llmWebModule],
  logLevel: 'warning'
})

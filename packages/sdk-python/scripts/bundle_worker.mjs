// Writes bare-stow's `bare-sidecar` package for Python to <out>: the worker
// with every built-in plugin, bundled for this host, and the `start()` that
// runs it.
//
// Usage: node scripts/bundle_worker.mjs <sdk-dir> <out>
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [sdkDir, outputDir] = process.argv.slice(2).map((arg) => path.resolve(arg))

const { bundleSdk } = await import(
  pathToFileURL(path.join(sdkDir, 'dist', 'src', 'commands', 'index.js')).href
)

await bundleSdk({
  projectRoot: sdkDir,
  sdkPath: sdkDir,
  target: 'bare-sidecar',
  language: 'python',
  outputDir,
  quiet: true
})

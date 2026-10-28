// Serves this example against the SDK package it lives in. In an app that
// installs @qvac/sdk from npm, no configuration is needed.
import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@qvac/sdk': fileURLToPath(new URL('../..', import.meta.url)) } },
  build: { target: 'es2022' },
  worker: { format: 'es' }
}

import { fileURLToPath } from 'node:url'
import { run } from '../../src/cli.js'

await run(process.argv.slice(2), {
  sdkToolsBin: fileURLToPath(new URL('./sdk-tools-bin.mjs', import.meta.url))
})

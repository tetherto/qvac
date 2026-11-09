import { fileURLToPath } from 'node:url'
import { make } from '@qvac/cli-kit/build'

make({
  name: '@qvac/duck',
  binary: 'duck',
  root: fileURLToPath(new URL('..', import.meta.url)),
  description: 'QVAC chat in your terminal',
  versions: [],
  stage: process.argv.includes('--stage')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})

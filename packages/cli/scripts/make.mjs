import { fileURLToPath } from 'node:url'
import { make } from '@qvac/cli-kit/build'

make({
  name: '@qvac/cli',
  binary: 'qvac',
  root: fileURLToPath(new URL('..', import.meta.url)),
  description: 'the qvac assistant in your terminal',
  versions: ['@qvac/sdk'],
  stage: process.argv.includes('--stage')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})

import { fileURLToPath } from 'node:url'
import { patchDependencies } from '@qvac/cli-kit/build'

const root = fileURLToPath(new URL('..', import.meta.url))

try {
  console.log(
    JSON.stringify(patchDependencies(root, { check: process.argv.includes('--check') }), null, 2)
  )
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}

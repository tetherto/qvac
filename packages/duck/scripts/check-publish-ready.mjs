// Gate for `npm publish` (wired via `prepublishOnly` in package.json).
import { fileURLToPath } from 'node:url'
import { checkPublishReady } from '@qvac/cli-kit/build'

const errors = checkPublishReady({ root: fileURLToPath(new URL('..', import.meta.url)) })

if (errors.length === 0) {
  process.exit(0)
}

const message = [
  '',
  'Cannot publish @qvac/duck — dependency metadata is not ready.',
  '',
  ...errors.map((e) => `  • ${e}`),
  '',
  'Regenerate npm-shrinkwrap.json and rebuild before publishing.',
  ''
].join('\n')

console.error(message)
process.exit(1)

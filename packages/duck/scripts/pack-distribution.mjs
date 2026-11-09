import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack } from '@qvac/cli-kit/build'

const root = fileURLToPath(new URL('..', import.meta.url))

pack({ root, destination: path.resolve(process.argv[2] || root) })

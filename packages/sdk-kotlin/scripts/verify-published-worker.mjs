import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function verifyWorkerMetadata(metadata, version) {
  if (metadata.version !== version || metadata.qvacIpcAuthentication !== 'token-v1') {
    throw new Error(`Cannot publish Kotlin ${version}: the published @qvac/sdk@${version} must declare token-v1 IPC. Publish the authenticated SDK first.`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(new URL('../../sdk/package.json', import.meta.url)))
  const metadata = JSON.parse(execFileSync('npm', ['view', `@qvac/sdk@${version}`, 'version', 'qvacIpcAuthentication', '--json'],
    { encoding: 'utf8', timeout: 30_000 }))
  verifyWorkerMetadata(metadata, version)
  console.log(`Published @qvac/sdk@${version} supports authenticated desktop IPC`)
}

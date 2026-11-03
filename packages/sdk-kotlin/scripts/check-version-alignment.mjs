import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import './verify-runtime-profiles.mjs'

const kotlinRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runtimePackage = JSON.parse(await fs.readFile(path.join(kotlinRoot, 'package.json'), 'utf8'))
const sdkPackage = JSON.parse(await fs.readFile(path.join(kotlinRoot, '..', 'sdk', 'package.json'), 'utf8'))

const runtimeVersion = runtimePackage.version
const workerVersion = runtimePackage.dependencies?.['@qvac/sdk']
const contractVersion = sdkPackage.version
if (runtimeVersion !== contractVersion || workerVersion !== contractVersion) {
  throw new Error(
    `Kotlin runtime version (${runtimeVersion}), @qvac/sdk dependency (${workerVersion}), ` +
      `and contract version (${contractVersion}) must match`
  )
}

console.log(`Verified Kotlin runtime, @qvac/sdk dependency and contract version ${contractVersion}`)

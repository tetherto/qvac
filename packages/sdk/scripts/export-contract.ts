import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  contractDir,
  registryEngineManifestFile,
  renderContractFiles,
  renderRegistryEngineManifest
} from './contract/build-contract'

const checkOnly = process.argv.includes('--check')

const files = await renderContractFiles()
const artifacts = [
  ...Object.entries(files).map(([name, content]) => ({
    label: `contract/${name}`,
    file: new URL(name, contractDir),
    content
  })),
  {
    label: 'registry-server/lib/generated/engine-manifest.json',
    file: registryEngineManifestFile,
    content: await renderRegistryEngineManifest()
  }
]

let stale = false
for (const { label, file, content } of artifacts) {
  const filePath = fileURLToPath(file)
  if (checkOnly) {
    const existing = await readFile(filePath, 'utf8').catch(function () {
      return null
    })
    if (existing !== content) {
      console.error(`${label} is ${existing === null ? 'missing' : 'out of date'}`)
      stale = true
    }
  } else {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
    console.log(`wrote ${label}`)
  }
}

if (stale) {
  console.error(
    "Generated contract artifacts are stale. Run 'npm run contract:export' and commit the result."
  )
  process.exit(1)
}

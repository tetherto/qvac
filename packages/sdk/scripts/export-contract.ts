import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  contractDir,
  registryEngineManifestFile,
  renderContractFiles,
  renderRegistryEngineManifest
} from './contract/build-contract'

const engineManifest = {
  label: 'registry-server/lib/generated/engine-manifest.json',
  file: registryEngineManifestFile,
  content: await renderRegistryEngineManifest()
}

// The registry server's validator reads its engine manifest with no SDK beside it, so that file is committed and
// checked. The contract files are written on demand and never committed.
if (process.argv.includes('--check-engine-manifest')) {
  const existing = await readFile(engineManifest.file, 'utf8').catch(function () {
    return null
  })
  if (existing !== engineManifest.content) {
    console.error(
      `${engineManifest.label} is ${existing === null ? 'missing' : 'out of date'}. ` +
        "Run 'npm run engine-manifest:write' and commit it."
    )
    process.exit(1)
  }
} else {
  const artifacts = process.argv.includes('--write-engine-manifest')
    ? [engineManifest]
    : Object.entries(await renderContractFiles()).map(([name, content]) => ({
        label: `contract/${name}`,
        file: new URL(name, contractDir),
        content
      }))
  for (const { label, file, content } of artifacts) {
    const filePath = fileURLToPath(file)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
    console.log(`wrote ${label}`)
  }
}

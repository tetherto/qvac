import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { contractDir, renderContractFiles } from '@/scripts/contract/build-contract'

const checkOnly = process.argv.includes('--check')

const files = await renderContractFiles()
await mkdir(contractDir, { recursive: true })

let stale = false
for (const [name, content] of Object.entries(files)) {
  const filePath = fileURLToPath(new URL(name, contractDir))
  if (checkOnly) {
    const existing = await readFile(filePath, 'utf8').catch(function () {
      return null
    })
    if (existing !== content) {
      console.error(`contract/${name} is ${existing === null ? 'missing' : 'out of date'}`)
      stale = true
    }
  } else {
    await writeFile(filePath, content)
    console.log(`wrote contract/${name}`)
  }
}

if (stale) {
  console.error(
    "Contract artifacts are stale. Run 'bun run contract:export' and commit the result."
  )
  process.exit(1)
}

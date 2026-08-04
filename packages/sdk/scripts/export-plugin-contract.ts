import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { buildPluginContract } from '@/scripts/contract/plugin-contract'
import type { QvacPlugin } from '@/schemas'

// Usage: tsx scripts/export-plugin-contract.ts <plugin-module> <out.json>
// The plugin module's default export must be a definePlugin(...) value.
const [modulePath, outPath] = process.argv.slice(2)
if (!modulePath || !outPath) {
  console.error('usage: export-plugin-contract <plugin-module> <out.json>')
  process.exit(1)
}

const imported = (await import(pathToFileURL(modulePath).href)) as { default?: QvacPlugin }
if (!imported.default) {
  console.error(`${modulePath} has no default export`)
  process.exit(1)
}

const contract = buildPluginContract(imported.default)
await writeFile(outPath, JSON.stringify(contract, null, 2) + '\n')
console.log(`wrote ${outPath} (${contract.handlers.length} handlers)`)

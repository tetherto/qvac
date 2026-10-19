import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const kotlinRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sdkPackage = JSON.parse(await fs.readFile(path.join(kotlinRoot, '..', 'sdk', 'package.json'), 'utf8'))
const aio = JSON.parse(await fs.readFile(path.join(kotlinRoot, 'qvac.config.json'), 'utf8'))

const exportsByImplementation = new Map()
for (const [exportName, descriptor] of Object.entries(sdkPackage.exports ?? {})) {
  if (!exportName.endsWith('/plugin')) continue
  const implementation = typeof descriptor === 'string' ? descriptor : descriptor.import
  const specifier = `@qvac/sdk/${exportName.slice(2)}`
  const aliases = exportsByImplementation.get(implementation) ?? []
  aliases.push(specifier)
  exportsByImplementation.set(implementation, aliases)
}

const configured = new Set(aio.plugins ?? [])
const missing = [...exportsByImplementation.values()].filter(
  (aliases) => !aliases.some((specifier) => configured.has(specifier))
)
if (missing.length > 0) {
  throw new Error(
    `The Android AIO profile is missing SDK plugin export(s): ${missing.map((aliases) => aliases.join(' or ')).join(', ')}`
  )
}

const known = new Set([...exportsByImplementation.values()].flat())
const configs = (await fs.readdir(kotlinRoot)).filter(name => /^qvac\.config(?:\.[\w-]+)?\.json$/.test(name))
for (const file of configs) {
  const { plugins } = JSON.parse(await fs.readFile(path.join(kotlinRoot, file), 'utf8'))
  if (!Array.isArray(plugins) || plugins.length === 0 || plugins.some(plugin => typeof plugin !== 'string')) {
    throw new Error(`${file} must contain a nonempty plugins array`)
  }
  if (new Set(plugins).size !== plugins.length) throw new Error(`${file} contains duplicate plugins`)
  const unknown = plugins.filter(plugin => !known.has(plugin))
  if (unknown.length) throw new Error(`${file} references unknown plugin exports: ${unknown.join(', ')}`)
  const outsideAio = plugins.filter(plugin => !configured.has(plugin))
  if (outsideAio.length) throw new Error(`${file} contains plugins missing from AIO: ${outsideAio.join(', ')}`)
}

console.log(`Verified ${configs.length} Android configurations and AIO coverage for ${exportsByImplementation.size} addon implementations`)

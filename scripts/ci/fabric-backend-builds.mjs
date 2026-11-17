import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

export const FABRIC_PORT = 'qvac-fabric'
const MODULE_PATTERN = /(?:\.(?:so(?:\..+)?|dll|dylib|metallib|xclbin|spv)|_insts\.txt)$/

export function recordedFabric(manifest) {
  const value = manifest?.qvac?.[FABRIC_PORT]
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:#\d+)?$/.test(value)) {
    throw new Error(`${manifest?.name ?? 'package'} has invalid qvac-fabric provenance`)
  }
  return value
}

function prebuildFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    return entry.isDirectory() ? prebuildFiles(file) : [file]
  })
}

export function backendFiles(packageRoot) {
  const root = join(packageRoot, 'prebuilds')
  return prebuildFiles(root)
    .filter((file) => MODULE_PATTERN.test(basename(file)))
    .map((file) => ({
      host: relative(root, file).split(sep)[0],
      name: basename(file),
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
    }))
}

function groupBy(items, key) {
  const groups = new Map()
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
  return groups
}

export function checkFabricBuilds(addons) {
  const recorded = addons.filter((addon) => Boolean(addon.fabric))
  const groups = groupBy(recorded, (addon) => addon.fabric)
  const errors =
    groups.size > 1
      ? [
          `incompatible qvac-fabric revisions: ${[...groups].map(([version, rows]) => `${version} (${rows.map((row) => row.id).join(', ')})`).join('; ')}`
        ]
      : []
  const unknownRuntime = addons.filter((addon) => 'fabric' in addon && !addon.fabric)
  if (recorded.length) {
    errors.push(
      ...unknownRuntime.map(
        (addon) =>
          `${addon.id} does not record its qvac-fabric revision; compatibility with speech backends cannot be verified`
      )
    )
  }
  return errors
}

export function checkBackendFiles(addons) {
  const files = addons.flatMap((addon) =>
    (addon.backendFiles ?? []).map((file) => ({ ...file, id: addon.id }))
  )
  const groups = groupBy(files, (file) => `${file.host}/${file.name}`)
  return [...groups]
    .filter(([, rows]) => new Set(rows.map((row) => row.sha256)).size > 1)
    .map(
      ([file, rows]) => `conflicting backend file ${file}: ${rows.map((row) => row.id).join(', ')}`
    )
}

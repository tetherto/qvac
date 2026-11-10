import fs from 'node:fs'
import path from 'node:path'
import Bundle from 'bare-bundle'

export interface BundleFileHeader {
  id?: string
  main?: string
  imports?: Record<string, unknown>
  resolutions?: Record<string, unknown>
}

/** Writes a bare-pack bundle wrapped the way bare-stow writes `bundle.cjs`. */
export function writeBundleFile(bundlePath: string, header: BundleFileHeader = {}): void {
  const bundle = new Bundle()
  bundle.id = header.id ?? 'test-bundle-id'
  if (header.main !== undefined) bundle.main = header.main
  if (header.imports !== undefined) bundle.imports = header.imports as Bundle['imports']
  bundle.resolutions = Object.fromEntries(
    Object.entries(header.resolutions ?? {}).map(([module, imports]) => [
      module,
      typeof imports === 'object' && imports !== null ? imports : {}
    ])
  ) as Bundle['resolutions']

  fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
  fs.writeFileSync(bundlePath, `module.exports = ${JSON.stringify(bundle.toBuffer().toString())}\n`)
}

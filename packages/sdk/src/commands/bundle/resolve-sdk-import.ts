import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type SdkExportEntry = string | { [condition: string]: SdkExportEntry }

const SDK_EXPORT_CONDITIONS = ['bare', 'import', 'module', 'default', 'node', 'require']

export function selectExportTarget(entry: SdkExportEntry | undefined): string | null {
  if (entry === null || entry === undefined) return null
  if (typeof entry === 'string') return entry
  for (const condition of SDK_EXPORT_CONDITIONS) {
    const resolved = selectExportTarget(entry[condition])
    if (resolved) return resolved
  }
  return null
}

function readPackageExports(packagePath: string): Record<string, SdkExportEntry> {
  try {
    const raw = fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { exports?: Record<string, SdkExportEntry> }
    return pkg.exports ?? {}
  } catch {
    return {}
  }
}

export function sdkImportsMap(sdkPath: string, sdkName: string): Record<string, string> {
  const imports: Record<string, string> = {}
  for (const [subpath, entry] of Object.entries(readPackageExports(sdkPath))) {
    if (subpath.includes('*')) continue
    const target = selectExportTarget(entry)
    if (target === null) continue
    const specifier = subpath === '.' ? sdkName : `${sdkName}/${subpath.slice(2)}`
    imports[specifier] = pathToFileURL(path.join(sdkPath, target)).href
  }
  return imports
}

/**
 * Maps `<sdkName>/<subpath>` to the file the SDK at `sdkPath` exports for it,
 * so a worker entry reaches an SDK that the project's own `node_modules` does
 * not resolve to. Other specifiers pass through.
 */
export function createSdkImportResolver(
  sdkPath: string,
  sdkName: string
): (specifier: string) => string {
  const prefix = `${sdkName}/`
  const exports = readPackageExports(sdkPath)

  return (specifier) => {
    if (!specifier.startsWith(prefix)) return specifier
    const target = selectExportTarget(exports[`./${specifier.slice(prefix.length)}`])
    return target ? pathToFileURL(path.join(sdkPath, target)).href : specifier
  }
}

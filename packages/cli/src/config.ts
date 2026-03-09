import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ConfigNotFoundError, ConfigLoadError } from './errors.js'

const require = createRequire(import.meta.url)

export const CONFIG_CANDIDATES = [
  'qvac.config.json',
  'qvac.config.js',
  'qvac.config.mjs',
  'qvac.config.ts'
]

export function findConfigFile (projectRoot: string, explicitPath?: string): string | null {
  if (explicitPath) {
    const absPath = path.resolve(projectRoot, explicitPath)
    if (fs.existsSync(absPath)) return absPath
    throw new ConfigNotFoundError(explicitPath)
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(projectRoot, candidate)
    if (fs.existsSync(configPath)) return configPath
  }

  return null
}

export async function loadConfig (configPath: string): Promise<unknown> {
  if (!configPath) {
    throw new ConfigNotFoundError(null, CONFIG_CANDIDATES)
  }

  const ext = path.extname(configPath).toLowerCase()

  try {
    if (ext === '.json') {
      const content = await fsp.readFile(configPath, 'utf8')
      return JSON.parse(content) as unknown
    }

    if (ext === '.js' || ext === '.mjs') {
      const fileUrl = `file://${configPath}`
      const mod = await import(fileUrl) as { default?: unknown }
      return mod.default ?? mod
    }

    if (ext === '.ts') {
      const tsxApiPath = require.resolve('tsx/esm/api')
      const { tsImport } = await import(tsxApiPath) as { tsImport: (path: string, base: string) => Promise<{ default?: unknown }> }
      const mod = await tsImport(configPath, import.meta.url)
      return mod.default ?? mod
    }

    throw new Error(
      `Unsupported config format: ${ext}. Use .json, .js, .mjs, or .ts`
    )
  } catch (error) {
    if (error instanceof ConfigNotFoundError) throw error
    throw new ConfigLoadError(configPath, error)
  }
}

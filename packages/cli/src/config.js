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

export function findConfigFile (projectRoot, explicitPath) {
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

export async function loadConfig (configPath) {
  if (!configPath) {
    throw new ConfigNotFoundError(null, CONFIG_CANDIDATES)
  }

  const ext = path.extname(configPath).toLowerCase()

  try {
    if (ext === '.json') {
      const content = await fsp.readFile(configPath, 'utf8')
      return JSON.parse(content)
    }

    if (ext === '.js' || ext === '.mjs') {
      const fileUrl = `file://${configPath}`
      const module = await import(fileUrl)
      return module.default ?? module
    }

    if (ext === '.ts') {
      const tsxApiPath = require.resolve('tsx/esm/api')
      const { tsImport } = await import(tsxApiPath)
      const module = await tsImport(configPath, import.meta.url)
      return module.default ?? module
    }

    throw new Error(
      `Unsupported config format: ${ext}. Use .json, .js, .mjs, or .ts`
    )
  } catch (error) {
    if (error instanceof ConfigNotFoundError) throw error
    throw new ConfigLoadError(configPath, error)
  }
}

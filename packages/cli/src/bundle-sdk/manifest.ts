import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { Logger } from '../logger.js'

interface BarePackHeader {
  id?: string
  resolutions?: Record<string, unknown>
}

interface GenerateAddonsManifestOptions {
  bundlePath: string
  outputDir: string
  projectRoot: string
  logger: Logger
}

interface GenerateAddonsManifestResult {
  manifestPath: string
  addons: string[]
}

export function extractPackedString (bundleJsText: string): string {
  const idx = bundleJsText.indexOf('module.exports')
  if (idx === -1) {
    throw new Error("bundle does not contain 'module.exports'")
  }

  const eq = bundleJsText.indexOf('=', idx)
  if (eq === -1) {
    throw new Error("could not find '=' after module.exports")
  }

  let i = eq + 1
  while (i < bundleJsText.length && /\s/.test(bundleJsText[i] ?? '')) i++

  const quote = bundleJsText[i]
  if (quote !== '"' && quote !== "'") {
    throw new Error('export value is not a string literal')
  }
  i++

  let out = ''
  let esc = false

  for (; i < bundleJsText.length; i++) {
    const ch = bundleJsText[i]!

    if (esc) {
      switch (ch) {
        case 'n': out += '\n'; break
        case 'r': out += '\r'; break
        case 't': out += '\t'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'v': out += '\v'; break
        case '\\': out += '\\'; break
        case '"': out += '"'; break
        case "'": out += "'"; break
        case 'x': {
          const hex = bundleJsText.slice(i + 1, i + 3)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error('bad \\x escape')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 2
          break
        }
        case 'u': {
          const hex = bundleJsText.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad \\u escape')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
          break
        }
        default:
          out += ch
      }
      esc = false
      continue
    }

    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === quote) break

    out += ch
  }

  if (i >= bundleJsText.length) {
    throw new Error('unterminated string literal')
  }

  return out
}

export function extractBarePackHeader (packed: string): BarePackHeader {
  const firstNL = packed.indexOf('\n')
  if (firstNL === -1) {
    throw new Error('packed string missing first newline separator')
  }

  const jsonStart = packed.indexOf('{', firstNL + 1)
  if (jsonStart === -1) {
    throw new Error('could not find header JSON start in packed string')
  }

  let i = jsonStart
  let depth = 0
  let inStr = false
  let esc = false

  for (; i < packed.length; i++) {
    const ch = packed[i]

    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }

    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
  }

  if (depth !== 0) {
    throw new Error('unbalanced braces while extracting header JSON')
  }

  return JSON.parse(packed.slice(jsonStart, i)) as BarePackHeader
}

export async function generateAddonsManifest (options: GenerateAddonsManifestOptions): Promise<GenerateAddonsManifestResult> {
  const { bundlePath, outputDir, projectRoot, logger } = options

  logger.info('\n📦 Generating addons manifest...')

  const bundleJsText = await fsp.readFile(bundlePath, 'utf8')
  const packed = extractPackedString(bundleJsText)
  const header = extractBarePackHeader(packed)
  const resolutions = header.resolutions ?? {}

  const packageNames = new Set<string>()
  const nodeModulesRegex = /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//

  for (const key of Object.keys(resolutions)) {
    const match = key.match(nodeModulesRegex)
    if (match?.[1]) {
      packageNames.add(match[1])
    }
  }

  const addons: string[] = []
  for (const pkgName of packageNames) {
    const pkgJsonPath = path.join(
      projectRoot,
      'node_modules',
      pkgName,
      'package.json'
    )
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf8')) as { addon?: boolean }
        if (pkgJson.addon === true) {
          addons.push(pkgName)
        }
      }
    } catch (err) {
      logger.warn(`   Could not read ${pkgName}/package.json: ${(err as Error).message}`)
    }
  }

  addons.sort()

  const bundleId =
    typeof header.id === 'string' && header.id.length > 0
      ? header.id
      : 'unknown'

  const manifest = {
    version: 1,
    bundleId,
    addons
  }

  const manifestPath = path.join(outputDir, 'addons.manifest.json')
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  logger.info(`   Found ${packageNames.size} packages in bundle graph`)
  logger.info(
    `   Identified ${addons.length} native addons: ${addons.join(', ') || '(none)'}`
  )
  logger.info(`   Wrote ${manifestPath}`)

  return { manifestPath, addons }
}

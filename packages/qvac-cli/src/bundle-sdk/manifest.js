import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'

/**
 * Extracts the packed string from a bare-pack bundle without executing it.
 * Bundle format: `module.exports = "<packed string>";`
 * @param {string} bundleJsText
 */
export function extractPackedString (bundleJsText) {
  const idx = bundleJsText.indexOf('module.exports')
  if (idx === -1) {
    throw new Error("bundle does not contain 'module.exports'")
  }

  const eq = bundleJsText.indexOf('=', idx)
  if (eq === -1) {
    throw new Error("could not find '=' after module.exports")
  }

  let i = eq + 1
  while (i < bundleJsText.length && /\s/.test(bundleJsText[i])) i++

  const quote = bundleJsText[i]
  if (quote !== '"' && quote !== "'") {
    throw new Error('export value is not a string literal')
  }
  i++ // past opening quote

  let out = ''
  let esc = false

  for (; i < bundleJsText.length; i++) {
    const ch = bundleJsText[i]

    if (esc) {
      switch (ch) {
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case 'v':
          out += '\v'
          break
        case '\\':
          out += '\\'
          break
        case '"':
          out += '"'
          break
        case "'":
          out += "'"
          break
        case 'x': {
          // \xHH
          const hex = bundleJsText.slice(i + 1, i + 3)
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new Error('bad \\x escape')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 2
          break
        }
        case 'u': {
          // \uHHHH
          const hex = bundleJsText.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad \\u escape')
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
          break
        }
        default:
          // Keep unknown escapes as-is
          out += ch
      }
      esc = false
      continue
    }

    if (ch === '\\') {
      esc = true
      continue
    }
    if (ch === quote) break // end of string literal

    out += ch
  }

  if (i >= bundleJsText.length) {
    throw new Error('unterminated string literal')
  }

  return out
}

export function extractBarePackHeader (packed) {
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
        i++ // include closing brace
        break
      }
    }
  }

  if (depth !== 0) {
    throw new Error('unbalanced braces while extracting header JSON')
  }

  return JSON.parse(packed.slice(jsonStart, i))
}

export async function generateAddonsManifest (options) {
  const { bundlePath, outputDir, projectRoot, logger } = options

  logger.info('\n📦 Generating addons manifest...')

  const bundleJsText = await fsp.readFile(bundlePath, 'utf8')
  const packed = extractPackedString(bundleJsText)
  const header = extractBarePackHeader(packed)
  const resolutions = header.resolutions ?? {}

  // Extract package names from resolution keys
  const packageNames = new Set()
  const nodeModulesRegex = /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//

  for (const key of Object.keys(resolutions)) {
    const match = key.match(nodeModulesRegex)
    if (match) {
      packageNames.add(match[1])
    }
  }

  // Check which packages have "addon": true
  const addons = []
  for (const pkgName of packageNames) {
    const pkgJsonPath = path.join(
      projectRoot,
      'node_modules',
      pkgName,
      'package.json'
    )
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf8'))
        if (pkgJson.addon === true) {
          addons.push(pkgName)
        }
      }
    } catch (err) {
      logger.warn(`   Could not read ${pkgName}/package.json: ${err.message}`)
    }
  }

  // Sort for deterministic output
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

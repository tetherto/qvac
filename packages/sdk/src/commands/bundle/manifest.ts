import fs, { promises as fsp } from 'node:fs'
import path from 'node:path'
import { readBundle } from '@/commands/bundle/read-bundle'
import type { Logger } from '@/logging/types'

interface GenerateAddonsManifestOptions {
  bundlePath: string
  outputDir: string
  projectRoot: string
  logger: Logger
  includeAudioDecoder?: boolean
}

export const AUDIO_DECODER_ADDON = 'bare-ffmpeg'

interface GenerateAddonsManifestResult {
  manifestPath: string
  addons: string[]
}

const NODE_MODULES_RE = /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)(?=\/)/g

export function buildNestedPathIndex(
  resolutions: Record<string, unknown>,
  projectRoot: string
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>()
  for (const key of Object.keys(resolutions)) {
    for (const match of key.matchAll(NODE_MODULES_RE)) {
      const pkgName = match[1]
      if (!pkgName) continue
      const idx = match.index
      if (idx === undefined) continue
      const marker = `/node_modules/${pkgName}/`
      const candidate = path.join(projectRoot, key.slice(1, idx + marker.length), 'package.json')
      let set = index.get(pkgName)
      if (!set) {
        set = new Set()
        index.set(pkgName, set)
      }
      set.add(candidate)
    }
  }
  return index
}

export async function generateAddonsManifest(
  options: GenerateAddonsManifestOptions
): Promise<GenerateAddonsManifestResult> {
  const { bundlePath, outputDir, projectRoot, logger, includeAudioDecoder = true } = options

  logger.info('\n📦 Generating addons manifest...')

  const bundle = await readBundle(bundlePath)
  const pathsByPackage = buildNestedPathIndex(bundle.resolutions, projectRoot)

  const addons: string[] = []
  for (const [pkgName, candidates] of pathsByPackage) {
    let pkgJson: { addon?: boolean } | null = null
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          pkgJson = JSON.parse(await fsp.readFile(candidate, 'utf8')) as { addon?: boolean }
          break
        }
      } catch (err) {
        logger.warn(`   Could not read ${candidate}: ${(err as Error).message}`)
      }
    }
    if (pkgJson?.addon === true && (includeAudioDecoder || pkgName !== AUDIO_DECODER_ADDON)) {
      addons.push(pkgName)
    }
  }

  addons.sort()

  const bundleId = bundle.id ?? 'unknown'

  const manifest = {
    version: 1,
    bundleId,
    addons
  }

  const manifestPath = path.join(outputDir, 'addons.manifest.json')
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  logger.info(`   Found ${pathsByPackage.size} packages in bundle graph`)
  logger.info(`   Identified ${addons.length} native addons: ${addons.join(', ') || '(none)'}`)
  logger.info(`   Wrote ${manifestPath}`)

  return { manifestPath, addons }
}

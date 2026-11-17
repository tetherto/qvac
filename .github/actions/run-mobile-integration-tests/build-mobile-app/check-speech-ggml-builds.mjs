import {
  backendFiles,
  checkBackendFiles,
  checkFabricBuilds,
  recordedFabric,
} from '../../../../scripts/ci/fabric-backend-builds.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SPEECH_ADDONS = ['@qvac/asr-ggml', '@qvac/audiogen-ggml', '@qvac/bci-whispercpp', '@qvac/tts-ggml']

const BUILD_FIELD = 'qvac'
const GGML_SPEECH = 'ggml-speech'
const DEFAULT_MODULES_DIR = 'node_modules'

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isDirectory(entry, parent) {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory()
  } catch {
    return false
  }
}

function listScopedPackageDirs(scopeDir) {
  return readDirSafe(scopeDir)
    .filter((entry) => isDirectory(entry, scopeDir))
    .map((entry) => path.join(scopeDir, entry.name))
}

function listPackageDirs(modulesDir) {
  return readDirSafe(modulesDir)
    .filter((entry) => !entry.name.startsWith('.') && isDirectory(entry, modulesDir))
    .flatMap((entry) => {
      const entryPath = path.join(modulesDir, entry.name)
      return entry.name.startsWith('@') ? listScopedPackageDirs(entryPath) : [entryPath]
    })
}

function readManifest(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function listInstalledPackages(modulesDir) {
  const packages = []
  const seen = new Set()
  const pending = [modulesDir]
  while (pending.length > 0) {
    for (const packageRoot of listPackageDirs(pending.pop())) {
      const identity = fs.realpathSync(packageRoot)
      if (seen.has(identity)) continue
      seen.add(identity)
      packages.push(packageRoot)
      pending.push(path.join(packageRoot, 'node_modules'))
    }
  }
  return packages
}

function describePackage(packageRoot) {
  const manifest = readManifest(packageRoot)
  if (!manifest) return []
  const families = [...SPEECH_ADDONS, '@qvac/fabric']
  if (!families.some((name) => manifest.name === name || manifest.name?.startsWith(name + '-'))) return []
  const known = SPEECH_ADDONS.includes(manifest.name) || manifest.name === '@qvac/fabric'
  const files = backendFiles(packageRoot)
  if (!known && files.length === 0) return []
  const row = { id: `${manifest.name}@${manifest.version}`, ggmlSpeech: manifest[BUILD_FIELD]?.[GGML_SPEECH] ?? null }
  const fabric = recordedFabric(manifest)
  if (files.length) row.backendFiles = files
  if (
    fabric !== null ||
    manifest.name === '@qvac/fabric' ||
    files.some((file) => /^(?:lib)?qvac-ggml-/.test(file.name))
  )
    row.fabric = fabric
  return [row]
}

export function findSpeechAddons(modulesDir) {
  return listInstalledPackages(modulesDir).flatMap(describePackage)
}

function groupByBuild(addons) {
  const groups = new Map()
  for (const addon of addons) {
    groups.set(addon.ggmlSpeech, [...(groups.get(addon.ggmlSpeech) ?? []), addon.id])
  }
  return groups
}

function formatGroups(groups) {
  return [...groups].map(([build, ids]) => `${build ?? 'not recorded'} (${ids.join(', ')})`).join('; ')
}

export function summarizeSpeechAddons(addons) {
  if (addons.some((addon) => 'fabric' in addon))
    return addons
      .map(
        (addon) =>
          `${addon.id}: ${Boolean(addon.fabric) ? 'qvac-fabric ' + addon.fabric : (addon.ggmlSpeech ?? 'unrecorded')}`
      )
      .join('; ')
  if (addons.length === 0) return `${GGML_SPEECH}: no speech addons installed`
  return `${GGML_SPEECH}: ${formatGroups(groupByBuild(addons))}`
}

export function checkSpeechAddons(addons) {
  if (addons.some((addon) => 'fabric' in addon)) {
    const older = addons.filter((addon) => !('fabric' in addon))
    const legacy = checkSpeechAddons(older)
    if (addons.length > 1 && older.length === 1 && older[0].ggmlSpeech === null)
      legacy.warnings.push(`${older[0].id} does not record the ggml-speech build it ships, so it cannot be checked`)
    return {
      errors: [...legacy.errors, ...checkFabricBuilds(addons), ...checkBackendFiles(addons)],
      warnings: legacy.warnings,
    }
  }
  if (addons.length <= 1) return { errors: [], warnings: [] }
  const recorded = groupByBuild(addons.filter((addon) => addon.ggmlSpeech !== null))
  const errors =
    recorded.size > 1
      ? [`speech addons built from ${recorded.size} ${GGML_SPEECH} versions: ${formatGroups(recorded)}`]
      : []
  const warnings = addons
    .filter((addon) => addon.ggmlSpeech === null)
    .map((addon) => `${addon.id} does not record the ${GGML_SPEECH} build it ships, so it cannot be checked`)
  return { errors, warnings }
}

export function parseArgs(argv) {
  const args = { modulesDir: DEFAULT_MODULES_DIR }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--modules-dir' && argv[i + 1]) args.modulesDir = argv[++i]
    else throw new Error(`unknown argument ${argv[i]}`)
  }
  return args
}

function report(level, lines) {
  const prefix = process.env.GITHUB_ACTIONS ? `::${level}::` : `${level}: `
  lines.forEach((line) => console.error(`${prefix}${line}`))
}

function main() {
  const { modulesDir } = parseArgs(process.argv.slice(2))
  const addons = findSpeechAddons(path.resolve(modulesDir))
  console.log(summarizeSpeechAddons(addons))
  const { errors, warnings } = checkSpeechAddons(addons)
  report('warning', warnings)
  if (errors.length === 0) return
  report('error', errors)
  console.error(
    'Install coordinated addon releases with matching backend revisions and identical colliding backend files.'
  )
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

#!/usr/bin/env node
/**
 * Fail unless asr-ggml, audiogen-ggml, bci-whispercpp and tts-ggml build their
 * ggml backends from one ggml-speech: the same ggml-speech and speech-cpp
 * overrides in every vcpkg.json, that ggml-speech recorded in every
 * package.json, and the same ggml-speech version and features in every addon's
 * vcpkg install plan for each prebuild triplet. Any other package that depends
 * on ggml-speech or speech-cpp fails it until it is listed as a speech addon.
 *
 * The plans come from `vcpkg install --dry-run` with compiler tracking off, so
 * no toolchain or build is needed.
 *
 * Usage:
 *   node .github/scripts/check-speech-ggml-lockstep.mjs [--vcpkg <path>]
 *
 *   --vcpkg defaults to $VCPKG_ROOT/vcpkg, else vcpkg on PATH.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GGML_SPEECH_PORT,
  PINNED_PORTS,
  SPEECH_ADDONS,
  checkAddonList,
  checkPins,
  checkPlans,
  findPin,
  parsePlannedPort,
  summarizePlans,
} from './lib/speech-ggml.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const PREBUILD_TRIPLETS = [
  'arm64-android',
  'arm64-ios',
  'arm64-ios-simulator',
  'x64-ios-simulator',
  'arm64-osx',
  'x64-osx',
  'x64-linux',
  'arm64-linux',
  'x64-windows',
]

const HOST_TRIPLETS = {
  'linux-x64': 'x64-linux',
  'linux-arm64': 'arm64-linux',
  'darwin-arm64': 'arm64-osx',
  'darwin-x64': 'x64-osx',
  'win32-x64': 'x64-windows',
}

const PACKAGES_DIR = 'packages'
const SHARED_TRIPLET_OVERLAY = 'vcpkg-overlays/triplets'
const ADDON_TRIPLET_OVERLAY = 'vcpkg/triplets'
const TRIPLET_EXTENSION = '.cmake'
const MISMATCH_HINT =
  'The speech addons ship their ggml backends under the same file names, so an app with two of them ' +
  'keeps one copy for both. Give all four the same ggml-speech and speech-cpp overrides and the same ' +
  'per-platform speech-cpp GPU features.'

function parseArgs(argv) {
  const args = { vcpkg: process.env.VCPKG_ROOT ? join(process.env.VCPKG_ROOT, 'vcpkg') : 'vcpkg' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vcpkg') {
      if (!argv[i + 1]) throw new Error('--vcpkg needs a path')
      args.vcpkg = argv[++i]
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  return args
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function loadAddons() {
  return SPEECH_ADDONS.map((addon) => ({
    ...addon,
    root: join(repoRoot, addon.dir),
    vcpkg: readJson(join(repoRoot, addon.dir, 'vcpkg.json')),
    manifest: readJson(join(repoRoot, addon.dir, 'package.json')),
  }))
}

function loadVcpkgPackages() {
  return readdirSync(join(repoRoot, PACKAGES_DIR))
    .map((name) => `${PACKAGES_DIR}/${name}`)
    .filter((dir) => existsSync(join(repoRoot, dir, 'vcpkg.json')))
    .map((dir) => ({ dir, vcpkg: readJson(join(repoRoot, dir, 'vcpkg.json')) }))
}

function hostTriplet() {
  const triplet = HOST_TRIPLETS[`${process.platform}-${process.arch}`]
  if (!triplet) throw new Error(`no vcpkg host triplet for ${process.platform}-${process.arch}`)
  return triplet
}

function listTriplets(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(TRIPLET_EXTENSION)) : []
}

function writePlanTriplet(name, overlays, outDir) {
  const source = overlays.map((dir) => join(dir, name)).find((path) => existsSync(path))
  const include = source.replaceAll('\\', '/')
  writeFileSync(join(outDir, name), `include("${include}")\nset(VCPKG_DISABLE_COMPILER_TRACKING ON)\n`)
}

function writePlanTriplets(addon, outDir) {
  const overlays = [join(addon.root, ADDON_TRIPLET_OVERLAY), join(repoRoot, SHARED_TRIPLET_OVERLAY)]
  mkdirSync(outDir, { recursive: true })
  new Set(overlays.flatMap(listTriplets)).forEach((name) => writePlanTriplet(name, overlays, outDir))
  return outDir
}

function runVcpkg(vcpkg, args) {
  const result = spawnSync(vcpkg, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${vcpkg} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

function planGgmlSpeech({ vcpkg, addon, triplet, tripletDir, runDir }) {
  const output = runVcpkg(vcpkg, [
    'install',
    '--dry-run',
    '--disable-metrics',
    '--binarysource=clear',
    `--triplet=${triplet}`,
    `--host-triplet=${hostTriplet()}`,
    `--overlay-triplets=${tripletDir}`,
    `--x-manifest-root=${addon.root}`,
    `--x-install-root=${join(runDir, 'installed')}`,
    `--x-buildtrees-root=${join(runDir, 'buildtrees')}`,
    `--x-packages-root=${join(runDir, 'packages')}`,
  ])
  const planned = parsePlannedPort(output, GGML_SPEECH_PORT)
  if (planned === null) {
    throw new Error(`vcpkg planned no ${GGML_SPEECH_PORT} for ${addon.name} on ${triplet}:\n${output}`)
  }
  return { addon: addon.name, triplet, planned }
}

function planAddon(vcpkg, addon, workDir) {
  const slug = addon.dir.replaceAll('/', '-')
  const tripletDir = writePlanTriplets(addon, join(workDir, slug, 'triplets'))
  return PREBUILD_TRIPLETS.map((triplet) =>
    planGgmlSpeech({ vcpkg, addon, triplet, tripletDir, runDir: join(workDir, slug, triplet) }),
  )
}

function planAddons(vcpkg, addons) {
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'speech-ggml-plans-'))
  try {
    return addons.flatMap((addon) => planAddon(vcpkg, addon, workDir))
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function fail(errors) {
  const prefix = process.env.GITHUB_ACTIONS ? '::error::' : 'error: '
  errors.forEach((line) => console.error(`${prefix}${line}`))
  console.error(MISMATCH_HINT)
  process.exitCode = 1
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const addons = loadAddons()
  const pinErrors = [...checkAddonList(loadVcpkgPackages()), ...checkPins(addons)]
  if (pinErrors.length > 0) return fail(pinErrors)

  const pins = PINNED_PORTS.map((port) => `${port} ${findPin(addons[0].vcpkg, port)}`)
  console.log(`${addons.map((addon) => addon.name).join(', ')} pin ${pins.join(' and ')}.`)

  const plans = planAddons(args.vcpkg, addons)
  summarizePlans(plans).forEach((line) => console.log(`  ${line}`))
  const planErrors = checkPlans(plans, findPin(addons[0].vcpkg, GGML_SPEECH_PORT))
  if (planErrors.length > 0) fail(planErrors)
}

main()

#!/usr/bin/env node
/**
 * Fail if installing a package together with all of its @qvac peers resolves
 * @qvac/infer-base, @qvac/logging, @qvac/error, or @qvac/fabric to more than
 * one version, or installs speech addons whose package.json records different
 * ggml-speech builds (they ship their ggml backends under the same file
 * names). A speech addon that records none is reported but cannot fail it.
 *
 * Only the dependency tree is resolved (npm --package-lock-only against a
 * tarball holding just package.json), so no build or prebuild download is
 * needed. Recorded ggml-speech builds come from npm view, or from the
 * package.json of a --local package.
 *
 * Usage:
 *   node .github/scripts/check-shared-runtime-libs.mjs [package-dir] [--local <dir>]...
 *
 *   package-dir defaults to packages/inference. Each --local package replaces
 *   its npm release in the tree, for a dependency that is ahead of npm.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildConsumerManifest,
  collectResolvedVersions,
  findDuplicates,
  formatDuplicates,
  formatResolved,
} from './lib/shared-runtime-libs.mjs'
import {
  BUILD_FIELD,
  SPEECH_ADDONS,
  checkRecordedBuilds,
  listInstalledBuilds,
  recordedGgmlSpeech,
  summarizeRecordedBuilds,
} from './lib/speech-ggml.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const SHARED_LIBS_HINT = 'Align the package that pulls the extra copy with the range the others use.'
const SPEECH_BUILDS_HINT = 'Depend on speech addon releases that record the same ggml-speech build.'

function parseArgs(argv) {
  const args = { packageDir: 'packages/inference', local: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local') {
      if (!argv[i + 1]) throw new Error('--local needs a package directory')
      args.local.push(argv[++i])
    } else if (argv[i].startsWith('-')) {
      throw new Error(`unknown argument: ${argv[i]}`)
    } else {
      args.packageDir = argv[i]
    }
  }
  return args
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function readPackageJson(packageDir) {
  return JSON.parse(readFileSync(join(resolve(repoRoot, packageDir), 'package.json'), 'utf8'))
}

// Packs package.json alone into <workDir>/<name>.tgz and returns its file: spec.
function packManifestOnly(packageDir, workDir, name) {
  const stageDir = join(workDir, `${name}-stage`)
  mkdirSync(join(stageDir, 'package'), { recursive: true })
  copyFileSync(join(resolve(repoRoot, packageDir), 'package.json'), join(stageDir, 'package', 'package.json'))
  run('tar', ['-czf', join(workDir, `${name}.tgz`), 'package'], stageDir)
  return `file:./${name}.tgz`
}

function resolveLockfile({ packageDir, local }) {
  const pkg = readPackageJson(packageDir)
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'shared-runtime-libs-'))
  try {
    const overrides = {}
    local.forEach((dir, index) => {
      overrides[readPackageJson(dir).name] = packManifestOnly(dir, workDir, `local-${index}`)
    })
    const manifest = buildConsumerManifest(pkg, packManifestOnly(packageDir, workDir, 'package'), overrides)
    writeFileSync(join(workDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], workDir)

    return { pkg, manifest, lockfile: JSON.parse(readFileSync(join(workDir, 'package-lock.json'), 'utf8')) }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

function readPublishedBuildField(name, version) {
  const output = run('npm', ['view', `${name}@${version}`, BUILD_FIELD, '--json'], repoRoot).trim()
  return output === '' ? undefined : JSON.parse(output)
}

function recordedBuildReader(localDirs) {
  const localManifests = new Map(localDirs.map((dir) => readPackageJson(dir)).map((pkg) => [pkg.name, pkg]))
  return (name, version) => {
    const local = localManifests.get(name)
    if (local?.version === version) return recordedGgmlSpeech(local)
    return recordedGgmlSpeech({ [BUILD_FIELD]: readPublishedBuildField(name, version) })
  }
}

function report(level, lines) {
  const prefix = process.env.GITHUB_ACTIONS ? `::${level}::` : `${level}: `
  lines.forEach((line) => console.error(`${prefix}${line}`))
}

function failWith(errors, hint) {
  if (errors.length === 0) return
  report('error', errors)
  console.error(hint)
  process.exitCode = 1
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const { pkg, manifest, lockfile } = resolveLockfile(args)
  const resolved = collectResolvedVersions(lockfile)
  const speechAddons = collectResolvedVersions(lockfile, SPEECH_ADDONS.map((addon) => addon.name))
  const builds = listInstalledBuilds(speechAddons, recordedBuildReader(args.local))

  const peers = Object.keys(manifest.dependencies).length - 1
  const localNote = manifest.overrides ? `, local ${Object.keys(manifest.overrides).join(', ')}` : ''
  console.log(`${pkg.name}@${pkg.version} with ${peers} @qvac peers${localNote}:`)
  for (const line of formatResolved(resolved)) console.log(`  ${line}`)
  console.log(`  ${summarizeRecordedBuilds(builds)}`)

  const speech = checkRecordedBuilds(builds)
  report('warning', speech.warnings)
  failWith(formatDuplicates(findDuplicates(resolved)), SHARED_LIBS_HINT)
  failWith(speech.errors, SPEECH_BUILDS_HINT)
}

main()

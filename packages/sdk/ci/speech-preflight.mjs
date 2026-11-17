import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { slicePlatformPackages } from '../../../scripts/ci/slice-platform-packages.mjs'
import { toLocalTarballSpec } from './e2e-inference.mjs'

export const PACKAGES = ['fabric', 'asr-ggml', 'tts-ggml', 'audiogen-ggml', 'bci-whispercpp']
const HOSTS = new Set(['linux-x64', 'darwin-arm64', 'win32-x64'])
const OMIT = new Set(['node_modules', 'prebuilds', 'build', 'dist', '.git'])
const MAX_COMPARISON_FILES = 300
const MAX_COMMAND_OUTPUT = 32 * 1024 * 1024
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const checksum = (file) => createHash('sha512').update(readFileSync(file)).digest('base64')

function command(program, args, cwd, env) {
  return execFileSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32' && program === 'npm',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: MAX_COMMAND_OUTPUT
  })
}

export function validateRun(run, config) {
  if (
    run.repository?.full_name !== config.repository ||
    run.head_sha !== config.sourceSha ||
    run.path !== config.workflow ||
    run.event !== 'workflow_dispatch'
  ) {
    throw new Error('Speech preflight build provenance does not match the pinned merge')
  }
}

function verifySources(root, config, env) {
  command(
    'git',
    [
      'diff',
      '--exit-code',
      'HEAD',
      '--',
      ...PACKAGES.map((name) => `packages/${name}`),
      'cmake/qvac-addon',
      'scripts/ci/slice-platform-packages.mjs'
    ],
    root,
    env
  )
  const sha = command('git', ['rev-parse', 'HEAD'], root, env).trim()
  const comparison = JSON.parse(
    command(
      'gh',
      ['api', `repos/${config.repository}/compare/${config.sourceSha}...${sha}`],
      root,
      env
    )
  )
  validateSources(comparison)
}

export function validateSources(comparison) {
  const prefixes = [...PACKAGES.map((name) => `packages/${name}/`), 'cmake/qvac-addon/']
  if (
    !['ahead', 'identical'].includes(comparison.status) ||
    !Array.isArray(comparison.files) ||
    comparison.files.length >= MAX_COMPARISON_FILES ||
    comparison.files.some(({ filename, previous_filename: previous }) =>
      [filename, previous]
        .filter(Boolean)
        .some(
          (name) =>
            name === 'scripts/ci/slice-platform-packages.mjs' ||
            prefixes.some((prefix) => name.startsWith(prefix))
        )
    )
  ) {
    throw new Error('Speech preflight sources differ from the native build revision')
  }
}

function downloadPackage(root, stage, slug, host, config, env) {
  const artifact = `prebuild-${slug}-${host}`
  const destination = join(stage, 'artifacts', slug)
  command(
    'gh',
    [
      'run',
      'download',
      String(config.runId),
      '--repo',
      config.repository,
      '--name',
      artifact,
      '--dir',
      destination
    ],
    root,
    env
  )
  const workdir = join(stage, 'packages', slug)
  cpSync(join(root, 'packages', slug), workdir, {
    recursive: true,
    filter: (source) => !OMIT.has(basename(source))
  })
  cpSync(join(destination, 'packages', slug, 'prebuilds'), join(workdir, 'prebuilds'), {
    recursive: true
  })
  return workdir
}

function nativeFiles(directory, prefix = '') {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const name = join(prefix, entry.name)
      return entry.isDirectory()
        ? nativeFiles(join(directory, entry.name), name)
        : [{ name, hash: checksum(join(directory, entry.name)) }]
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

function pack(workdir, stage, env) {
  const output = command(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', stage],
    workdir,
    env
  )
  const [{ filename }] = JSON.parse(output)
  const tarball = join(stage, filename)
  return {
    name: readJson(join(workdir, 'package.json')).name,
    spec: toLocalTarballSpec(tarball),
    integrity: `sha512-${checksum(tarball)}`,
    native: nativeFiles(join(workdir, 'prebuilds'))
  }
}

function packPackage(workdir, stage, slug, env) {
  const slices = slicePlatformPackages({
    workdir,
    outDir: join(stage, 'slices'),
    keepDirs: slug === 'fabric' ? ['include', 'share'] : []
  })
  return [...slices.map((slice) => pack(slice, stage, env)), pack(workdir, stage, env)]
}

export function applyOverrides(file, packages) {
  const manifest = readJson(file)
  manifest.overrides ??= {}
  for (const { name, spec } of packages) {
    manifest.overrides[name] = spec
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (manifest[section]?.[name]) manifest[section][name] = spec
    }
  }
  writeJson(file, manifest)
}

export function prepareSpeechPreflight(root, env, host = `${process.platform}-${process.arch}`) {
  const file = join(root, 'packages/sdk/ci/speech-preflight.json')
  if (!existsSync(file)) return null
  if (!HOSTS.has(host)) throw new Error(`Speech preflight does not support ${host}`)
  const config = readJson(file)
  const auth = { ...env, GH_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN }
  const run = JSON.parse(
    command('gh', ['api', `repos/${config.repository}/actions/runs/${config.runId}`], root, auth)
  )
  validateRun(run, config)
  verifySources(root, config, auth)
  const stage = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'speech-sdk-preflight-'))
  const packages = PACKAGES.flatMap((slug) => {
    const workdir = downloadPackage(root, stage, slug, host, config, auth)
    return packPackage(workdir, stage, slug, env)
  })
  for (const target of ['sdk', 'sdk-e2e']) {
    applyOverrides(join(root, 'packages', target, 'package.json'), packages)
  }
  return { ...config, host, packages }
}

function installedDirectory(anchor, name) {
  return dirname(createRequire(anchor).resolve(`${name}/package`))
}

function verifyPackage(e2e, anchor, lock, expected) {
  const directory = installedDirectory(anchor, expected.name)
  const key = relative(e2e, directory).replaceAll('\\', '/')
  if (lock.packages?.[key]?.integrity !== expected.integrity) {
    throw new Error(`Speech preflight installed an unexpected tarball for ${expected.name}`)
  }
  if (
    JSON.stringify(nativeFiles(join(directory, 'prebuilds'))) !== JSON.stringify(expected.native)
  ) {
    throw new Error(`Speech preflight native payload differs for ${expected.name}`)
  }
  return directory
}

export function verifySpeechPreflight(e2e, provenance) {
  if (!provenance) return
  const anchor = join(e2e, 'node_modules/@qvac/sdk/package.json')
  const lock = readJson(join(e2e, 'package-lock.json'))
  const installed = provenance.packages.map((expected) => ({
    name: expected.name,
    directory: verifyPackage(e2e, anchor, lock, expected)
  }))
  const fabric = realpathSync(installed.find((entry) => entry.name === '@qvac/fabric').directory)
  for (const slug of PACKAGES.slice(1)) {
    const consumer = installed.find((entry) => entry.name === `@qvac/${slug}`).directory
    const resolved = installedDirectory(join(consumer, 'package.json'), '@qvac/fabric')
    if (realpathSync(resolved) !== fabric) {
      throw new Error(`${slug} resolves a separate Fabric runtime`)
    }
  }
  const report = join(e2e, 'reports')
  mkdirSync(report, { recursive: true })
  writeJson(join(report, 'speech-preflight-provenance.json'), provenance)
  console.log(
    `Speech SDK preflight: verified ${provenance.host} payloads from ${provenance.sourceSha}`
  )
}

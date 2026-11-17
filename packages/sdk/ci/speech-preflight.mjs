import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  cpSync,
  createWriteStream,
  renameSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import {
  SLICE_DEFINITIONS,
  PLATFORM_INDEX_SOURCE,
  buildSliceManifest,
  expectedAddonFile,
  mangledAddonName
} from '../../../scripts/ci/slice-platform-packages.mjs'
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

async function verifySources(root, config, env) {
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
  const comparison = await (
    await github(config, env, `compare/${config.sourceSha}...${sha}`)
  ).json()
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

async function github(config, env, endpoint) {
  const response = await fetch(`https://api.github.com/repos/${config.repository}/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN || env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json'
    }
  })
  if (!response.ok) throw new Error(`Speech preflight GitHub ${endpoint}: HTTP ${response.status}`)
  return response
}

export async function downloadArtifact(config, env, name, destination) {
  const listing = await (
    await github(
      config,
      env,
      `actions/runs/${config.runId}/artifacts?name=${encodeURIComponent(name)}`
    )
  ).json()
  const artifacts = listing.artifacts.filter(
    (artifact) => artifact.name === name && !artifact.expired
  )
  if (artifacts.length !== 1) {
    throw new Error(`Speech preflight requires one available artifact: ${name}`)
  }
  mkdirSync(destination, { recursive: true })
  const archive = join(destination, 'artifact.zip')
  const response = await github(config, env, `actions/artifacts/${artifacts[0].id}/zip`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
  if (process.platform === 'win32') {
    command('tar', ['-xf', archive, '-C', destination], destination, env)
  } else {
    command('unzip', ['-q', archive, '-d', destination], destination, env)
  }
}

async function downloadPackage(root, stage, slug, host, config, env) {
  const artifact = `prebuild-${slug}-${host}`
  const destination = join(stage, 'artifacts', slug)
  await downloadArtifact(config, env, artifact, destination)
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

export function packPackage(workdir, stage, host, env) {
  const manifest = readJson(join(workdir, 'package.json'))
  const definition = SLICE_DEFINITIONS.find((slice) => slice.hosts.includes(host))
  if (!definition || !HOSTS.has(host)) throw new Error(`Unsupported speech preflight host: ${host}`)
  const prebuilds = join(workdir, 'prebuilds')
  const addon =
    manifest.addon === true
      ? `${mangledAddonName(manifest.name)}.bare`
      : expectedAddonFile(manifest.name, host)
  if (!existsSync(join(prebuilds, host, addon))) {
    throw new Error(`Missing native addon for ${manifest.name} on ${host}`)
  }
  if (manifest.addon === true) return [pack(workdir, stage, env)]
  const slice = join(stage, 'slices', `${basename(workdir)}-${host}`)
  mkdirSync(join(slice, 'prebuilds'), { recursive: true })
  writeJson(join(slice, 'package.json'), buildSliceManifest(manifest, definition))
  writeFileSync(join(slice, 'index.js'), PLATFORM_INDEX_SOURCE)
  renameSync(join(prebuilds, host), join(slice, 'prebuilds', host))
  copyLicenses(workdir, slice)
  return [pack(slice, stage, env), pack(workdir, stage, env)]
}

function copyLicenses(source, destination) {
  for (const name of ['LICENSE', 'NOTICE']) {
    if (existsSync(join(source, name))) cpSync(join(source, name), join(destination, name))
  }
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

export async function prepareSpeechPreflight(
  root,
  env,
  host = `${process.platform}-${process.arch}`
) {
  const file = join(root, 'packages/sdk/ci/speech-preflight.json')
  if (!existsSync(file)) return null
  if (!HOSTS.has(host)) throw new Error(`Speech preflight does not support ${host}`)
  const config = readJson(file)
  const run = await (await github(config, env, `actions/runs/${config.runId}`)).json()
  validateRun(run, config)
  await verifySources(root, config, env)
  const stage = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'speech-sdk-preflight-'))
  const packages = await collectPackages(root, stage, host, config, env)
  return { ...config, host, packages }
}

async function collectPackages(root, stage, host, config, env) {
  const packages = []
  for (const slug of PACKAGES) {
    const workdir = await downloadPackage(root, stage, slug, host, config, env)
    packages.push(...packPackage(workdir, stage, host, env))
  }
  return packages
}

export function installSpeechPreflight(root, env, provenance) {
  if (!provenance) return
  for (const target of ['sdk', 'sdk-e2e']) {
    applyOverrides(join(root, 'packages', target, 'package.json'), provenance.packages)
  }
  command('npm', ['install', '--ignore-scripts'], join(root, 'packages/sdk'), env)
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

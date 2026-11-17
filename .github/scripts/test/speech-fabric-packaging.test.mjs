import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { backendFiles, checkBackendFiles, checkFabricBuilds } from '../../../scripts/ci/fabric-backend-builds.mjs'
import { speechAddons } from '../../../scripts/ci/check-speech-ggml-builds.mjs'
import { checkPins, checkPlans, FABRIC_PORT } from '../lib/speech-ggml.mjs'
import {
  findSpeechAddons,
  checkSpeechAddons,
} from '../../actions/run-mobile-integration-tests/build-mobile-app/check-speech-ggml-builds.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const revision = '11739.3.0#1'
const addons = ['asr-ggml', 'tts-ggml', 'audiogen-ggml', 'bci-whispercpp']

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'speech-fabric-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file, contents) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

function packageFixture(modules, name, version, bytes, port = revision) {
  const dir = join(modules, name)
  write(join(dir, 'package.json'), JSON.stringify({ name, version, qvac: { 'qvac-fabric': port } }))
  write(join(dir, 'prebuilds/android-arm64/module/libqvac-ggml-cpu.so'), bytes)
  return dir
}

test('speech port pins, metadata and CI dependency match Fabric without an npm runtime dependency', () => {
  const manifests = addons.map((name) => {
    const dir = join(root, 'packages', name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json')))
    const vcpkg = JSON.parse(readFileSync(join(dir, 'vcpkg.json')))
    const project = JSON.parse(readFileSync(join(dir, 'project.json')))
    assert.equal(manifest.dependencies?.['@qvac/fabric'], undefined)
    assert.ok(project.implicitDependencies.includes('@qvac/fabric'))
    assert.equal(manifest.qvac['qvac-fabric'], revision)
    assert.equal(
      vcpkg.overrides.some((entry) => entry.name === 'ggml-speech'),
      false
    )
    return { name, vcpkg, manifest }
  })
  assert.deepEqual(checkPins(manifests), [])
  manifests[0].vcpkg.dependencies.find((entry) => entry.name === FABRIC_PORT)['version>='] = '11739.2.1'
  assert.match(checkPins(manifests).join('\n'), /floor matching its exact override/)
})

test('backend plan comparison ignores llama code but retains backend features and resolved revision', () => {
  const plan = (features, version = revision) => ({
    addon: features.join('-'),
    triplet: 'x64-linux',
    planned: { features, version },
  })
  assert.deepEqual(
    checkPlans([plan(['core', 'gpu-backends']), plan(['llama', 'gpu-backends', 'core'])], revision, FABRIC_PORT),
    []
  )
  assert.match(
    checkPlans([plan(['core', 'gpu-backends']), plan(['core'])], revision, FABRIC_PORT).join('\n'),
    /2 qvac-fabric builds/
  )
  assert.match(checkPlans([plan(['core'], '11739.3.0')], revision, FABRIC_PORT).join('\n'), /override pins/)
})

test('installed speech and Fabric require matching port revisions, including port-version', () => {
  const speech = { id: '@qvac/asr-ggml@1', fabric: revision }
  assert.deepEqual(checkFabricBuilds([speech, { id: '@qvac/fabric@1', fabric: revision }]), [])
  assert.match(checkFabricBuilds([speech, { id: '@qvac/fabric@1', fabric: '11739.3.0' }]).join('\n'), /incompatible/)
  assert.match(checkFabricBuilds([speech, { id: '@qvac/fabric@1', fabric: null }]).join('\n'), /cannot be verified/)
})

test('installed bundle rejects different binaries with the same host and name, even at the same revision', (t) => {
  const modules = scratch(t)
  packageFixture(modules, '@qvac/asr-ggml', '1', 'same')
  const fabric = packageFixture(modules, '@qvac/fabric', '1', 'same')
  assert.deepEqual(checkSpeechAddons(findSpeechAddons(modules)).errors, [])
  write(join(fabric, 'prebuilds/android-arm64/module/libqvac-ggml-cpu.so'), 'different')
  assert.match(checkSpeechAddons(findSpeechAddons(modules)).errors.join('\n'), /conflicting backend file android-arm64/)
})

test('platform packages participate in binary checks and different hosts do not collide', (t) => {
  const modules = scratch(t)
  const dir = packageFixture(modules, '@qvac/asr-ggml-android-arm64', '1', 'android')
  write(join(dir, 'prebuilds/linux-x64/module/libqvac-ggml-cpu.so'), 'linux')
  const files = backendFiles(dir)
  assert.equal(files.length, 2)
  assert.deepEqual(checkBackendFiles([{ id: 'a', backendFiles: files }]), [])
  assert.equal(findSpeechAddons(modules).length, 1)
})

test('legacy conflicts are still rejected alongside modern addons and runtime resources are compared', (t) => {
  const modules = scratch(t)
  const speech = packageFixture(modules, '@qvac/asr-ggml', '1', 'cpu')
  const fabric = packageFixture(modules, '@qvac/fabric', '1', 'cpu')
  write(join(speech, 'prebuilds/android-arm64/module/libc++_shared.so'), 'one-runtime')
  write(join(fabric, 'prebuilds/android-arm64/module/libc++_shared.so'), 'another-runtime')
  assert.match(checkSpeechAddons(findSpeechAddons(modules)).errors.join('\n'), /libc\+\+_shared/)
  const legacy = (name, build) => {
    write(join(modules, name, 'package.json'), JSON.stringify({ name, version: '1', qvac: { 'ggml-speech': build } }))
    write(join(modules, name, 'prebuilds/android-arm64/module/libqvac-speech-ggml-cpu.so'), build)
  }
  legacy('@qvac/tts-ggml', '2026-10-07')
  legacy('@qvac/audiogen-ggml', '2026-10-08')
  assert.match(checkSpeechAddons(findSpeechAddons(modules)).errors.join('\n'), /2 ggml-speech versions/)
})

function configureStaging(dir, apple = false) {
  write(
    join(dir, 'CMakeLists.txt'),
    `cmake_minimum_required(VERSION 3.25)
project(staging NONE)
set(APPLE ${apple ? 'TRUE' : 'FALSE'})
set(VCPKG_INSTALLED_PATH "${dir}/installed")
set(GGML_BACKEND_DL ON)
set(GGML_AVAILABLE_BACKENDS ggml-cpu ggml-vulkan)
add_library(ggml::ggml-cpu STATIC IMPORTED)
add_library(ggml::ggml-vulkan MODULE IMPORTED)
include("${root}/cmake/qvac-addon/speech-backends.cmake")
qvac_speech_collect_backends(exports files)
file(WRITE "${dir}/exports.txt" "\${exports}")
install(FILES \${files} DESTINATION backends)
`
  )
  return spawnSync('cmake', ['-S', dir, '-B', join(dir, 'build'), `-DCMAKE_INSTALL_PREFIX=${dir}/package`], {
    encoding: 'utf8',
  })
}

test('CMake stages loose Windows modules without CUDA and excludes static imported libraries', (t) => {
  const dir = scratch(t)
  write(join(dir, 'installed/bin/qvac-ggml-vulkan.dll'), 'vulkan')
  write(join(dir, 'installed/lib/qvac-ggml-cpu.dll'), 'cpu')
  const configured = configureStaging(dir)
  assert.equal(configured.status, 0, configured.stderr)
  assert.equal(readFileSync(join(dir, 'exports.txt'), 'utf8'), 'INSTALL;TARGET;ggml::ggml-vulkan')
  const installed = spawnSync('cmake', ['--install', join(dir, 'build')], { encoding: 'utf8' })
  assert.equal(installed.status, 0, installed.stderr)
  assert.equal(readFileSync(join(dir, 'package/backends/qvac-ggml-cpu.dll'), 'utf8'), 'cpu')
  assert.equal(readFileSync(join(dir, 'package/backends/qvac-ggml-vulkan.dll'), 'utf8'), 'vulkan')
})

test('CMake rejects an empty dynamic backend payload, while Apple keeps static packaging', (t) => {
  const dir = scratch(t)
  assert.match(configureStaging(dir).stderr, /backend modules are missing/)
  const apple = scratch(t)
  const configured = configureStaging(apple, true)
  assert.equal(configured.status, 0, configured.stderr)
  assert.equal(readFileSync(join(apple, 'exports.txt'), 'utf8'), '')
})

test('mobile preparation compares the root package binaries against installed dependencies', (t) => {
  const dir = scratch(t)
  const modules = join(dir, 'node_modules')
  const addon = packageFixture(dir, 'addon', '1', 'speech')
  packageFixture(modules, '@qvac/fabric', '1', 'fabric')
  const pkg = { name: '@qvac/asr-ggml', version: '1', qvac: { 'qvac-fabric': revision } }
  const found = speechAddons(modules, pkg, addon)
  assert.match(checkSpeechAddons(found).errors.join('\n'), /conflicting backend file android-arm64/)
})

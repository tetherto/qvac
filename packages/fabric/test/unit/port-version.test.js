'use strict'

// The qvac-fabric port checks, run against fixtures instead of a native build:
// qvac_fabric_installed_port_version() reads the port from vcpkg's SPDX
// document, and qvac_addon_link_fabric_server_context() compares an addon's
// own port build with the one the @qvac/fabric runtime records.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { packageRoot } = require('./helpers')

const portCmake = path.join(packageRoot, 'cmake/qvac-fabric-port.cmake')
const addonCmake = path.resolve(packageRoot, '../../cmake/qvac-addon/qvac-addon.cmake')

function executable(binary) {
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(binary, fs.constants.X_OK)
    } catch {
      fs.chmodSync(binary, 0o755)
    }
  }
  return binary
}

const cmake = executable(require('cmake-runtime')())
const ninja = executable(require('ninja-runtime')())

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-fabric-port-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function cmakePath(file) {
  return file.split(path.sep).join('/')
}

// A vcpkg_installed/<triplet> directory holding the SPDX document vcpkg writes
// for qvac-fabric, listing `packages` (another package first, as vcpkg does).
function writeInstalled(root, packages) {
  const share = path.join(root, 'share/qvac-fabric')
  fs.mkdirSync(share, { recursive: true })
  fs.writeFileSync(
    path.join(share, 'vcpkg.spdx.json'),
    JSON.stringify({ spdxVersion: 'SPDX-2.2', packages })
  )
  return root
}

function readPort(t, installed) {
  const script = path.join(tempDir(t), 'read.cmake')
  fs.writeFileSync(
    script,
    `include("${cmakePath(portCmake)}")\n` +
      `qvac_fabric_installed_port_version("${cmakePath(installed)}" version)\n` +
      'message(STATUS "port=${version}")\n'
  )
  return spawnSync(cmake, ['-P', script], { encoding: 'utf8' })
}

test('the installed port is read from its SPDX entry, port version included', (t) => {
  const installed = writeInstalled(tempDir(t), [
    { name: 'qvac-fabric_x64-linux@12032.0.0#1', versionInfo: 'ignored' },
    { name: 'qvac-fabric', versionInfo: '12032.0.0#1' }
  ])
  const result = readPort(t, installed)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /-- port=12032\.0\.0#1\n/)
})

test('reading the port fails without the SPDX document or its qvac-fabric entry', (t) => {
  const missing = readPort(t, tempDir(t))
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr.replace(/\s+/g, ' '), /vcpkg\.spdx\.json not found/)

  const installed = writeInstalled(tempDir(t), [{ name: 'llama', versionInfo: '1.0.0' }])
  const unnamed = readPort(t, installed)
  assert.notEqual(unnamed.status, 0)
  assert.match(unnamed.stderr.replace(/\s+/g, ' '), /names no qvac-fabric package/)
})

// Configures a consumer that links server-context from `addonPort`, against a
// @qvac/fabric whose CMake config records `runtimePort` (none when null).
function configureAddon(t, { addonPort, runtimePort }) {
  const root = tempDir(t)
  const installed = writeInstalled(path.join(root, 'vcpkg_installed'), [
    { name: 'qvac-fabric', versionInfo: addonPort }
  ])
  const llamaDir = path.join(installed, 'share/llama')
  fs.mkdirSync(llamaDir, { recursive: true })
  fs.writeFileSync(
    path.join(llamaDir, 'llamaConfig.cmake'),
    'if(NOT TARGET llama::server-context)\n' +
      '  add_library(llama::server-context STATIC IMPORTED)\n' +
      '  set_target_properties(llama::server-context PROPERTIES\n' +
      '    IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/../../lib/libserver-context.a")\n' +
      'endif()\n'
  )

  const source = path.join(root, 'src')
  fs.mkdirSync(source)
  const runtime =
    runtimePort === null
      ? ''
      : `set(QVAC_FABRIC_PORT_VERSION "${runtimePort}")\ninclude("${cmakePath(portCmake)}")\n`
  fs.writeFileSync(
    path.join(source, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.25)\n' +
      // No compiler: the helper's calls on the addon target are recorded.
      'project(PortFixture LANGUAGES NONE)\n' +
      'function(target_include_directories)\n' +
      '  message(STATUS "fixture: include ${ARGN}")\n' +
      'endfunction()\n' +
      'function(target_link_libraries)\n' +
      '  message(STATUS "fixture: link ${ARGN}")\n' +
      'endfunction()\n' +
      'function(target_compile_definitions)\n' +
      '  message(STATUS "fixture: define ${ARGN}")\n' +
      'endfunction()\n' +
      `include("${cmakePath(addonCmake)}")\n` +
      // What qvac_addon_use_fabric() and the runtime's CMake config leave.
      `set(qvac-fabric_DIR "${cmakePath(root)}/fabric")\n` +
      'add_library(qvac-fabric::headers INTERFACE IMPORTED)\n' +
      runtime +
      `set(llama_DIR "${cmakePath(llamaDir)}")\n` +
      'qvac_addon_link_fabric_server_context(addon)\n'
  )
  return spawnSync(
    cmake,
    ['-S', source, '-B', path.join(root, 'build'), '-G', 'Ninja', `-DCMAKE_MAKE_PROGRAM=${ninja}`],
    { encoding: 'utf8' }
  )
}

test('an addon links server-context when its port matches the runtime', (t) => {
  const result = configureAddon(t, { addonPort: '12032.0.0#1', runtimePort: '12032.0.0#1' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(
    result.stdout,
    /server-context from qvac-fabric 12032\.0\.0#1, matching @qvac\/fabric/
  )
  assert.match(
    result.stdout,
    /fixture: link addon;PRIVATE;\$<TARGET_LINKER_FILE:llama::server-context>/
  )
  assert.match(result.stdout, /fixture: include addon;PRIVATE;.*\/include\/llama\/server-context/)
  // For the check when the addon loads, against qvac_fabric_port_version().
  assert.match(
    result.stdout,
    /fixture: define addon;PRIVATE;QVAC_FABRIC_SERVER_CONTEXT_PORT="12032\.0\.0#1"/
  )
})

test('an addon whose port differs from the runtime fails to configure', (t) => {
  for (const addonPort of ['11739.4.0', '12032.0.0#1']) {
    const result = configureAddon(t, { addonPort, runtimePort: '12032.0.0' })
    assert.notEqual(result.status, 0, addonPort)
    const message = result.stderr.replace(/\s+/g, ' ')
    const expected =
      `server-context comes from qvac-fabric ${addonPort}, but the installed ` +
      '@qvac/fabric runtime was built from qvac-fabric 12032.0.0.'
    assert.ok(message.includes(expected), message)
  }
})

test('an addon fails to configure against a runtime that records no port', (t) => {
  const result = configureAddon(t, { addonPort: '12032.0.0', runtimePort: null })
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr.replace(/\s+/g, ' '),
    /does not record the qvac-fabric port it was built from \(QVAC_FABRIC_PORT_VERSION\)/
  )
})

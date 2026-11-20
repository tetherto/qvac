'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { packageRoot } = require('./helpers')

function configure(host, change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-shared-core-'))
  const module = 'qvac__fabric-' + host
  const directory = path.join(root, 'prebuilds', host, module)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'qvac-shared-core.cmake'),
    'set(_qvac_core_abi 1)\nset(_qvac_core_definitions "GGML_SHARED;GGML_MAX_NAME=128")\n'
  )
  for (const library of ['ggml-base', 'ggml', 'ggml-vector-index']) {
    const names = host.startsWith('win32-')
      ? [`qvac-${library}-1.dll`, `qvac-${library}-1.lib`]
      : [`libqvac-${library}-1.so`]
    for (const name of names) {
      const target = name.endsWith('.dll') ? path.dirname(directory) : directory
      fs.writeFileSync(path.join(target, name), '')
    }
  }
  const cmakePath = (p) => p.replace(/\\/g, '/')
  const statements = [
    'cmake_minimum_required(VERSION 3.25)',
    'project(packaged_core LANGUAGES NONE)',
    'add_library(qvac-fabric::headers INTERFACE IMPORTED)',
    `include("${cmakePath(path.join(packageRoot, 'cmake/qvac-fabric-hosts.cmake'))}")`,
    `include("${cmakePath(path.join(packageRoot, 'cmake/qvac-fabric-shared-core.cmake'))}")`,
    `qvac_fabric_import_shared_core("${cmakePath(root)}/prebuilds" "${host}")`,
    `qvac_fabric_import_shared_core("${cmakePath(root)}/prebuilds" "${host}")`,
    'get_target_property(location qvac-fabric::ggml-base IMPORTED_LOCATION)',
    'get_target_property(implib qvac-fabric::ggml-base IMPORTED_IMPLIB)',
    'get_target_property(definitions qvac-fabric::ggml-base INTERFACE_COMPILE_DEFINITIONS)',
    'get_target_property(dependencies qvac-fabric::ggml INTERFACE_LINK_LIBRARIES)',
    'file(WRITE "${CMAKE_BINARY_DIR}/import.txt" "${location}\n${implib}\n${definitions}\n${dependencies}")'
  ]
  change({ root, directory, statements })
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), statements.join('\n'))
  try {
    const result = spawnSync('cmake', ['-S', root, '-B', path.join(root, 'build')], {
      encoding: 'utf8'
    })
    assert.ifError(result.error)
    return {
      ...result,
      imported:
        result.status === 0 ? fs.readFileSync(path.join(root, 'build/import.txt'), 'utf8') : ''
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('platform-local core imports retain ABI names, headers and DLL import libraries', () => {
  for (const host of ['linux-x64', 'android-arm64', 'win32-x64']) {
    const result = configure(host)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.imported, /qvac-ggml-base-1\.(so|dll)/)
    assert.match(result.imported, /GGML_SHARED;GGML_MAX_NAME=128/)
    assert.match(result.imported, /qvac-fabric::headers;qvac-fabric::ggml-base/)
    if (host === 'win32-x64') assert.match(result.imported, /qvac-ggml-base-1\.lib/)
  }
})

test('missing Windows import library fails before linking', () => {
  const result = configure('win32-x64', ({ directory }) => {
    fs.unlinkSync(path.join(directory, 'qvac-ggml-base-1.lib'))
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Missing shared-core import library/)
})

test('incompatible or missing core metadata fails closed', () => {
  for (const metadata of [null, 'set(_qvac_core_abi 2)']) {
    const result = configure('linux-x64', ({ directory }) => {
      const file = path.join(directory, 'qvac-shared-core.cmake')
      if (metadata === null) fs.unlinkSync(file)
      else fs.writeFileSync(file, metadata)
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /No shared-core metadata|Unsupported QVAC shared-core ABI/)
  }
})

test('two platform packages cannot silently select different core providers', () => {
  const result = configure('linux-x64', ({ root, statements }) => {
    fs.cpSync(path.join(root, 'prebuilds'), path.join(root, 'other'), { recursive: true })
    statements.push(
      `qvac_fabric_import_shared_core("${root.replace(/\\/g, '/')}/other" "linux-x64")`
    )
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cannot mix shared-core packages/)
})

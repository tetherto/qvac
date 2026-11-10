import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchDependencies, planPackagePatch } from '../../scripts/patch-dependencies.mjs'

test('patch planning preserves pristine inputs and includes new runtime files', (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-dependency-patch-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0' })
  )
  fs.writeFileSync(path.join(target, 'runtime.js'), 'original\n')
  const patch = path.join(target, 'compat.patch')
  fs.writeFileSync(
    patch,
    [
      'diff --git a/runtime.js b/runtime.js',
      '--- a/runtime.js',
      '+++ b/runtime.js',
      '@@ -1 +1 @@',
      '-original',
      '+compatible',
      'diff --git a/shim.js b/shim.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/shim.js',
      '@@ -0,0 +1 @@',
      '+shim',
      ''
    ].join('\n')
  )
  const changes = planPackagePatch('fixture@1.0.0', { target, patch })
  assert.deepEqual(changes, [
    { destination: path.join(target, 'runtime.js'), after: 'compatible\n' },
    { destination: path.join(target, 'shim.js'), after: 'shim\n' }
  ])
  assert.equal(fs.readFileSync(path.join(target, 'runtime.js'), 'utf8'), 'original\n')
  assert.equal(fs.existsSync(path.join(target, 'shim.js')), false)
  for (const { destination, after } of changes) fs.writeFileSync(destination, after)
  assert.deepEqual(planPackagePatch('fixture@1.0.0', { target, patch }), [])
  assert.throws(() => planPackagePatch('fixture@2.0.0', { target, patch }), /Cannot patch/)
  fs.writeFileSync(path.join(target, 'runtime.js'), 'unexpected\n')
  assert.throws(() => planPackagePatch('fixture@1.0.0', { target, patch }), /[Pp]atch|hunk/)
  assert.equal(fs.readFileSync(path.join(target, 'runtime.js'), 'utf8'), 'unexpected\n')
})

test('the harness patches apply to installed packages and skip one left out of the install', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-dependency-patch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const agent = process.env.npm_config_user_agent
  delete process.env.npm_config_user_agent
  t.after(() => {
    if (agent !== undefined) process.env.npm_config_user_agent = agent
  })
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  const manifest = (name, version) => JSON.stringify({ name, version, main: 'index.js' })
  write('package.json', manifest('host', '1.0.0'))
  write('node_modules/@qvac/harness/package.json', manifest('@qvac/harness', '1.0.0'))
  write('node_modules/@qvac/harness/index.js', '')
  write('node_modules/fixture/package.json', manifest('fixture', '1.0.0'))
  write('node_modules/fixture/index.js', 'original\n')
  const patch = [
    'diff --git a/index.js b/index.js',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-original',
    '+patched',
    ''
  ].join('\n')
  write('node_modules/@qvac/harness/patches/fixture@1.0.0.patch', patch)
  write('node_modules/@qvac/harness/patches/absent@1.0.0.patch', patch)

  const result = patchDependencies(root)
  assert.deepEqual(result.results.map((r) => [r.package, r.state]).sort(), [
    ['absent@1.0.0', 'not installed'],
    ['fixture@1.0.0', 'patched']
  ])
  assert.equal(
    fs.readFileSync(path.join(root, 'node_modules/fixture/index.js'), 'utf8'),
    'patched\n'
  )
  assert.equal(
    patchDependencies(root).results.find((r) => r.package === 'fixture@1.0.0').state,
    'already patched'
  )
})

test('the CLI patches apply to installed packages and skip one left out of the install', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-dependency-patch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const agent = process.env.npm_config_user_agent
  delete process.env.npm_config_user_agent
  t.after(() => {
    if (agent !== undefined) process.env.npm_config_user_agent = agent
  })
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  const manifest = (name, version) => JSON.stringify({ name, version, main: 'index.js' })
  write('package.json', manifest('host', '1.0.0'))
  write('node_modules/@qvac/harness/package.json', manifest('@qvac/harness', '1.0.0'))
  write('node_modules/@qvac/harness/index.js', '')
  write('node_modules/fixture/package.json', manifest('fixture', '1.0.0'))
  write('node_modules/fixture/index.js', 'original\n')
  const patch = [
    'diff --git a/index.js b/index.js',
    '--- a/index.js',
    '+++ b/index.js',
    '@@ -1 +1 @@',
    '-original',
    '+patched',
    ''
  ].join('\n')
  write('patches/fixture@1.0.0.patch', patch)
  write('patches/absent@1.0.0.patch', patch)

  const result = patchDependencies(root)
  assert.deepEqual(result.results.map((r) => [r.package, r.state]).sort(), [
    ['absent@1.0.0', 'not installed'],
    ['fixture@1.0.0', 'patched']
  ])
  assert.equal(
    fs.readFileSync(path.join(root, 'node_modules/fixture/index.js'), 'utf8'),
    'patched\n'
  )
})

test('the unpdf patch passes omitted structuredClone options for Bare', (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-dependency-patch-'))
  t.after(() => fs.rmSync(target, { recursive: true, force: true }))
  const patch = fileURLToPath(new URL('../../patches/unpdf@1.6.2.patch', import.meta.url))
  // rebuild the hunk's original text at its recorded line, from the patch itself
  const lines = fs.readFileSync(patch, 'utf8').split('\n')
  const header = lines.findIndex((line) => line.startsWith('@@ '))
  const start = Number(lines[header].match(/^@@ -(\d+)/)[1])
  const original = lines
    .slice(header + 1)
    .filter((line) => line[0] === ' ' || line[0] === '-')
    .map((line) => line.slice(1))
  fs.mkdirSync(path.join(target, 'dist'))
  fs.writeFileSync(
    path.join(target, 'package.json'),
    JSON.stringify({ name: 'unpdf', version: '1.6.2' })
  )
  fs.writeFileSync(
    path.join(target, 'dist/pdfjs.mjs'),
    [...Array(start - 1).fill(''), ...original, ''].join('\n')
  )

  const [change] = planPackagePatch('unpdf@1.6.2', { target, patch })
  assert.equal(change.destination, path.join(target, 'dist/pdfjs.mjs'))
  assert.match(change.after, /structuredClone\(s,a\?\{transfer:a\}:undefined\)/)
  assert.match(change.after, /structuredClone\(e,n\?\{transfer:n\}:undefined\)/)
  assert.doesNotMatch(change.after, /structuredClone\([^)]*\}:null\)/)
})

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-publish-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const name of ['package.json', 'npm-shrinkwrap.json', 'scripts']) {
    fs.cpSync(path.join(root, name), path.join(dir, name), {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
      filter: (file) => !file.split(path.sep).includes('node_modules')
    })
  }
  return dir
}

function check(dir) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts/check-publish-ready.cjs')], {
    encoding: 'utf8'
  })
}

test('publish check accepts the committed manifest and distribution lock', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/check-publish-ready.cjs')])
})

test('publish check rejects a stale npm dependency lock', (t) => {
  const dir = fixture(t)
  const file = path.join(dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.dependencies['paparam'] = '1.0.0'
  fs.writeFileSync(file, JSON.stringify(pkg))
  const result = check(dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /npm-shrinkwrap\.json dependencies\["paparam"\] differs/)
})

test('publish check requires a distribution lock', (t) => {
  const dir = fixture(t)
  fs.unlinkSync(path.join(dir, 'npm-shrinkwrap.json'))
  const result = check(dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /npm-shrinkwrap\.json is missing/)
})

test('publish check allows CI package-name normalization', (t) => {
  const dir = fixture(t)
  const file = path.join(dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.name = '@tetherto/cli-mono'
  fs.writeFileSync(file, JSON.stringify(pkg))
  assert.equal(check(dir).status, 0)
})

test('npm archive includes the distribution lock', (t) => {
  const dir = fixture(t)
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-pack-cache-'))
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }))
  const output = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache],
    { cwd: dir, encoding: 'utf8' }
  )
  const [archive] = JSON.parse(output)
  assert.ok(archive.files.some((file) => file.path === 'npm-shrinkwrap.json'))
})

test('publish check rejects arbitrary local SDK dependencies', (t) => {
  const dir = fixture(t),
    file = path.join(dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  pkg.dependencies['@qvac/sdk'] = 'file:../sdk'
  fs.writeFileSync(file, JSON.stringify(pkg))
  const result = check(dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /still points at a local path/)
})

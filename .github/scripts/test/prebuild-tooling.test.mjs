import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/reusable-prebuilds.yml'), 'utf8')
const CUDA = readFileSync(join(ROOT, '.github/actions/setup-cuda/action.yml'), 'utf8')
const INSTALL_FAILURE = 47
const NPM_FIXTURE = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.NPM_CALLS, JSON.stringify(args) + '\\n')
const resources = args.some(arg => arg.startsWith('llvm-runtime-resources-darwin@'))
if (process.env.FAIL_INSTALL === 'first' || (resources && process.env.FAIL_INSTALL === 'resources')) {
  process.exit(${INSTALL_FAILURE})
}
function write(name, text, mode) {
  const target = path.join(process.cwd(), 'node_modules', name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, mode ? { mode } : undefined)
}
write('bare-make/package.json', JSON.stringify({ version: '2.1.0' }))
write('.bin/bare-make', '#!/usr/bin/env node\\nconsole.log("v2.1.0")\\n', 0o755)
write('llvm-runtime/package.json', JSON.stringify({ version: '23.1.3', exports: {
  './package': './package.json', './resource-dir': './resource-dir.js'
} }))
write('llvm-runtime/resource-dir.js', 'module.exports = () => require("llvm-runtime-resources-darwin")\\n')
if (resources) write('llvm-runtime-resources-darwin/index.js', 'module.exports = "/fixture/resources"\\n')
`

function installBody() {
  const step = WORKFLOW.split('      - name: Install current bare-make locally\n')[1]
    .split('\n      - ')[0]
  return step.split('        run: |\n')[1].split('\n').map(line => line.slice(10)).join('\n')
}

function installTooling(platform, failInstall = '') {
  const directory = mkdtempSync(join(tmpdir(), 'prebuild-tooling-'))
  const callsFile = join(directory, 'calls.jsonl')
  const outputFile = join(directory, 'github-path')
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), NPM_FIXTURE, { mode: 0o755 })
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', installBody()], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, RUNNER_OS: platform,
        NPM_CALLS: callsFile, GITHUB_PATH: outputFile, FAIL_INSTALL: failInstall },
    })
    const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    return { ...result, calls }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('macOS makes the matching LLVM resources required without pruning bare-make', () => {
  const result = installTooling('macOS')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.calls, [
    ['install', '--no-save', '--ignore-scripts', 'bare-make'],
    ['install', '--no-save', '--ignore-scripts', 'bare-make@2.1.0', 'llvm-runtime-resources-darwin@23.1.3'],
  ])
  assert.match(result.stdout, /v2\.1\.0/)
})

test('non-Apple runners keep their existing tooling installation', () => {
  for (const platform of ['Linux', 'Windows']) {
    const result = installTooling(platform)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.calls, [['install', '--no-save', '--ignore-scripts', 'bare-make']])
  }
})

test('a missing LLVM resource download fails the setup before CMake', () => {
  const result = installTooling('macOS', 'resources')
  assert.equal(result.status, INSTALL_FAILURE, result.stderr)
  assert.equal(result.calls.length, 2)
  assert.doesNotMatch(result.stdout, /v2\.1\.0/)
})

test('the initial tooling install failure is preserved', () => {
  const result = installTooling('macOS', 'first')
  assert.equal(result.status, INSTALL_FAILURE, result.stderr)
  assert.equal(result.calls.length, 1)
})

function runDownload(url, output) {
  const command = CUDA.match(/^\s*(curl -fsSL[^\n]+)$/m)[1]
  return new Promise((resolveResult, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', command], {
      env: { ...process.env, url, out: output },
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.resume()
    child.on('error', reject)
    child.on('close', status => resolveResult({ status, stderr }))
  })
}

test('CUDA downloads retry a reset connection and retain the complete archive', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cuda-download-'))
  let requests = 0
  const payload = 'complete CUDA archive fixture'
  const server = createServer((req, res) => {
    requests++
    if (requests === 1) return req.socket.destroy()
    res.end(payload)
  })
  t.after(() => {
    server.closeAllConnections()
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const output = join(directory, 'archive.tar.xz')
  const result = await runDownload(`http://127.0.0.1:${server.address().port}/archive`, output)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(requests, 2)
  assert.equal(readFileSync(output, 'utf8'), payload)
})

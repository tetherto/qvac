#!/usr/bin/env node
// The SDK as a consumer installs it, from this build's tarball with the in-repo @qvac/inference: no peer-resolution drift,
// and a default and a lean (--omit=optional) install with no peer warnings, one copy of each shared P2P package, and the
// full API on import. Run by the sdk's test:unit after its build, in temporary directories only.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = fileURLToPath(new URL('..', import.meta.url))
const inference = join(sdk, '..', 'inference')
const SHARED = ['corestore', 'hyperswarm', 'hyperdrive', 'hyperdb', 'hyperblobs', 'hyperdht']
const PEER = /ERESOLVE|npm warn (peerOptional|peer)( |$)/m
let failed = 0
const fail = (msg) => {
  console.log(`::error::${msg}`)
  failed++
}
const npm = (args, cwd) => {
  const r = spawnSync('npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  const log = `${r.stdout}${r.stderr}`
  process.stdout.write(log)
  return { ok: r.status === 0, log }
}
const pack = (dir, dest) =>
  join(
    dest,
    execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', dest], {
      cwd: dir,
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .pop()
  )

const work = mkdtempSync(join(tmpdir(), 'sdk-consumer-'))
const inferenceTgz = pack(inference, work)
const sdkTgz = pack(sdk, work)

// The SDK's manifest against the in-repo engine, as main's workspace source linked it: peer resolution must be clean.
{
  const dir = mkdtempSync(join(tmpdir(), 'sdk-peers-'))
  const manifest = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'))
  manifest.dependencies['@qvac/inference'] = `file:${inferenceTgz}`
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const { ok, log } = npm(
    [
      'install',
      '--no-fund',
      '--no-audit',
      '--ignore-scripts',
      '--install-links',
      '--loglevel=info'
    ],
    dir
  )
  if (!ok) fail('npm install of the SDK manifest failed')
  if (PEER.test(log)) {
    fail('SDK npm peer-resolution drift: npm install surfaced peer dependency errors or warnings')
  }
}

for (const [label, extra] of [
  ['default', []],
  ['lean (--omit=optional)', ['--omit=optional']]
]) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-consumer-'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'sdk-consumer', version: '1.0.0', type: 'module', overrides: { '@qvac/inference': `file:${inferenceTgz}` } }, null, 2)}\n`
  )
  const { ok, log } = npm(
    ['install', '--no-fund', '--no-audit', '--ignore-scripts', ...extra, '--loglevel=info', sdkTgz],
    dir
  )
  if (!ok) fail(`[${label}] npm install failed`)
  if (/ERESOLVE|npm warn peer/.test(log)) {
    fail(`[${label}] SDK consumer install surfaced peer warnings`)
  } else {
    console.log(`::notice::[${label}] 0 peer warnings`)
  }
  for (const name of SHARED) {
    const tree = spawnSync('npm', ['ls', name, '--all'], {
      cwd: dir,
      encoding: 'utf8',
      shell: process.platform === 'win32'
    })
    const out = `${tree.stdout}${tree.stderr}`
    const copies = out
      .split('\n')
      .filter((l) => new RegExp(`[─ ]${name}@`).test(l) && !l.includes('deduped')).length
    if (copies !== 1) {
      fail(`[${label}] ${name} resolved to ${copies} copies (expected 1)`)
      console.log(out)
    } else console.log(`  ok  [${label}] ${name} = 1 copy`)
  }
  const load = spawnSync(
    'node',
    [
      '-e',
      `import('@qvac/sdk').then(m => { if (Object.keys(m).length < 50) { console.error('FAIL: too few exports'); process.exit(1) } console.log('[${label}] import ok:', Object.keys(m).length, 'exports') }).catch(e => { console.error('[${label}] FAIL:', e.message); process.exit(1) })`
    ],
    { cwd: dir, stdio: 'inherit' }
  )
  if (load.status !== 0) fail(`[${label}] import('@qvac/sdk') failed`)
}

for (const f of readdirSync(work)) console.log(`packed ${f}`)
if (failed) {
  console.log(`::error::${failed} consumer install check(s) failed`)
  process.exit(1)
}
console.log('Consumer install checks passed')

import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ensureAppBinary, formatSize, resolveBaseUrl } from '@/app/binary'
import { privateTempDir, runBinary } from '@/app/run'

const CLI_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts')
const VERSION = (
  JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version
const HOST_KEY = `${process.platform}-${process.arch}`
const BINARY_NAME = process.platform === 'win32' ? 'qvac.exe' : 'qvac'
const FILE = `qvac-${HOST_KEY}.gz`
const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000
const SKIP_EXEC =
  process.platform === 'win32'
    ? 'the fake binary is a shebang script, not a Windows executable'
    : false

function fakeBinary(exitCode: number): string {
  return `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\nprocess.exit(${exitCode})\n`
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function entry(gz: Buffer, file = FILE): Record<string, unknown> {
  return { file, sha256: sha256(gz), size: gz.length }
}

function manifest(version: string, gz: Buffer, overrides: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 1, version, binaries: { [HOST_KEY]: entry(gz), ...overrides } }
}

class Stalled {
  head: Buffer
  constructor(head: Buffer) {
    this.head = head
  }
}

interface Fixture {
  baseUrl: string
  requests: string[]
}

async function serve(t: TestContext, files: Record<string, unknown>): Promise<Fixture> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const file = files[(req.url ?? '').slice(1)]
    if (file === undefined) {
      res.writeHead(404).end()
      return
    }
    if (file instanceof Stalled) {
      if (file.head.length > 0) res.write(file.head)
      return
    }
    res.end(typeof file === 'string' || Buffer.isBuffer(file) ? file : JSON.stringify(file))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, requests }
}

async function downUrl(): Promise<string> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

async function cacheDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-app-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function seed(dir: string, version: string, checkedAt: number): Promise<string> {
  const file = join(dir, 'versions', version, BINARY_NAME)
  await mkdir(join(dir, 'versions', version), { recursive: true })
  await writeFile(file, fakeBinary(0), { mode: 0o755 })
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version, checkedAt }))
  return file
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

async function readState(dir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
}

async function runCli(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    cwd: CLI_ROOT,
    env: { ...process.env, ...env }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += String(d)
  })
  child.stderr.on('data', (d) => {
    stderr += String(d)
  })
  const [code] = (await once(child, 'close')) as [number | null]
  return { stdout, stderr, code }
}

describe('qvac app', () => {
  it(
    'first run downloads, verifies and runs the binary with the exact arguments',
    { skip: SKIP_EXEC },
    async (t) => {
      const body = fakeBinary(7)
      const gz = gzipSync(body)
      const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gz), [FILE]: gz })
      const dir = await cacheDir(t)

      const r = await runCli(['app', 'workspaces', 'list', '--json'], {
        QVAC_APP_CLI_URL: `${baseUrl}/`,
        QVAC_APP_CLI_DIR: dir
      })

      assert.equal(r.code, 7)
      assert.deepEqual(JSON.parse(r.stdout), ['workspaces', 'list', '--json'])
      assert.equal(r.stderr, `Downloading the QV.AC app CLI 1.0.0 (${gz.length} B)...\n`)
      assert.equal(await readFile(join(dir, 'versions', '1.0.0', BINARY_NAME), 'utf8'), body)
      assert.equal(((await readState(dir)) as { version: string }).version, '1.0.0')
    }
  )

  it('passes --version --help -x foo to the binary untouched', { skip: SKIP_EXEC }, async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gz), [FILE]: gz })
    const dir = await cacheDir(t)

    const r = await runCli(['app', '--version', '--help', '-x', 'foo'], {
      QVAC_APP_CLI_URL: baseUrl,
      QVAC_APP_CLI_DIR: dir
    })

    assert.equal(r.code, 0)
    assert.deepEqual(JSON.parse(r.stdout), ['--version', '--help', '-x', 'foo'])
  })

  it('lists app in qvac --help', async () => {
    const help = await runCli(['--help'], {})
    assert.equal(help.code, 0)
    assert.match(help.stdout, /app \[args\.\.\.\]\s+Run the QV\.AC app CLI/)
  })

  it('leaves the parsing of other commands as on main', async () => {
    for (const args of [
      ['doctor', '--version'],
      ['serve', 'openai', '-p', '8080', '--version']
    ]) {
      const r = await runCli(args, {})
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`)
      assert.equal(r.stdout, `${VERSION}\n`)
    }
  })

  it('refuses a checksum mismatch and leaves no file under versions/', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const wrong = sha256('something else')
    const { baseUrl } = await serve(t, {
      'manifest.json': manifest('1.0.0', gz, { [HOST_KEY]: { ...entry(gz), sha256: wrong } }),
      [FILE]: gz
    })
    const dir = await cacheDir(t)

    await assert.rejects(
      ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }),
      (error: Error) => {
        assert.ok(error.message.includes(wrong), error.message)
        assert.ok(error.message.includes(sha256(gz)), error.message)
        return true
      }
    )
    assert.deepEqual(await filesUnder(join(dir, 'versions')), [])
  })

  it('refuses a size mismatch and leaves no file under versions/', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, {
      'manifest.json': manifest('1.0.0', gz, { [HOST_KEY]: { ...entry(gz), size: 1 } }),
      [FILE]: gz
    })
    const dir = await cacheDir(t)

    await assert.rejects(
      ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }),
      /Checksum or size mismatch/
    )
    assert.deepEqual(await filesUnder(join(dir, 'versions')), [])
  })

  it('refuses a truncated gzip body and leaves no file under versions/', async (t) => {
    const truncated = gzipSync(fakeBinary(0)).subarray(0, 20)
    const { baseUrl } = await serve(t, {
      'manifest.json': manifest('1.0.0', truncated),
      [FILE]: truncated
    })
    const dir = await cacheDir(t)

    await assert.rejects(
      ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }),
      /Could not download .*unexpected end of file/
    )
    assert.deepEqual(await filesUnder(join(dir, 'versions')), [])
  })

  it('makes no request when checkedAt is fresh', async (t) => {
    const { baseUrl, requests } = await serve(t, {})
    const dir = await cacheDir(t)
    const file = await seed(dir, '1.0.0', NOW - HOUR)

    assert.equal(await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }), file)
    assert.deepEqual(requests, [])
  })

  it('switches to a newer version when checkedAt is stale and removes the old one', async (t) => {
    const body = fakeBinary(0)
    const gz = gzipSync(body)
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('2.0.0', gz), [FILE]: gz })
    const dir = await cacheDir(t)
    await seed(dir, '1.0.0', NOW - 25 * HOUR)
    await mkdir(join(dir, 'versions', '1.0.0', 'tmp'))

    const file = await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW })

    assert.equal(file, join(dir, 'versions', '2.0.0', BINARY_NAME))
    assert.equal(await readFile(file, 'utf8'), body)
    assert.deepEqual(await readdir(join(dir, 'versions')), ['2.0.0'])
    assert.deepEqual(await readdir(dir), ['state.json', 'versions'])
    assert.deepEqual(await readState(dir), { version: '2.0.0', checkedAt: NOW })
  })

  it('keeps an old version while a launcher still runs it', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('2.0.0', gz), [FILE]: gz })
    const dir = await cacheDir(t)
    await seed(dir, '1.0.0', NOW - 25 * HOUR)
    await mkdir(join(dir, 'versions', '1.0.0', 'tmp'))
    await mkdir(join(dir, 'versions', '1.0.0', 'run'))
    await writeFile(join(dir, 'versions', '1.0.0', 'run', String(process.pid)), '')

    await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW })

    assert.deepEqual(await readdir(join(dir, 'versions')), ['1.0.0', '2.0.0'])
    assert.ok(existsSync(join(dir, 'versions', '1.0.0', 'tmp')))
  })

  it('removes an old version whose launcher has exited', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('2.0.0', gz), [FILE]: gz })
    const dir = await cacheDir(t)
    await seed(dir, '1.0.0', NOW - 25 * HOUR)
    const exited = spawn(process.execPath, ['-e', ''])
    await once(exited, 'exit')
    await mkdir(join(dir, 'versions', '1.0.0', 'run'))
    await writeFile(join(dir, 'versions', '1.0.0', 'run', String(exited.pid)), '')

    await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW })

    assert.deepEqual(await readdir(join(dir, 'versions')), ['2.0.0'])
  })

  it('removes every other cached version after a switch', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('2.0.0', gz), [FILE]: gz })
    const dir = await cacheDir(t)
    await seed(dir, '0.9.0', NOW - 50 * HOUR)
    await seed(dir, '1.0.0', NOW - 25 * HOUR)

    await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW })

    assert.deepEqual(await readdir(join(dir, 'versions')), ['2.0.0'])
  })

  it(
    'switches when an old version cannot be removed',
    { skip: process.platform === 'win32' ? 'directory modes do not block removal' : false },
    async (t) => {
      const gz = gzipSync(fakeBinary(0))
      const { baseUrl } = await serve(t, { 'manifest.json': manifest('2.0.0', gz), [FILE]: gz })
      const dir = await cacheDir(t)
      await seed(dir, '0.9.0', NOW - 50 * HOUR)
      await seed(dir, '1.0.0', NOW - 25 * HOUR)
      await chmod(join(dir, 'versions', '0.9.0'), 0o500)

      const file = await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }).finally(
        () => chmod(join(dir, 'versions', '0.9.0'), 0o700)
      )

      assert.equal(file, join(dir, 'versions', '2.0.0', BINARY_NAME))
      assert.deepEqual(await readdir(join(dir, 'versions')), ['0.9.0', '2.0.0'])
    }
  )

  it('prints the download size in a readable unit', () => {
    assert.equal(formatSize(999), '999 B')
    assert.equal(formatSize(1536), '1.5 kB')
    assert.equal(formatSize(650 * 1024 * 1024), '650.0 MB')
    assert.equal(formatSize(1.7 * 1024 ** 3), '1.7 GB')
    assert.equal(formatSize(5000 * 1024 ** 3), '5000.0 GB')
  })

  it('runs the cached binary when checkedAt is stale and the server is down', async (t) => {
    const dir = await cacheDir(t)
    const file = await seed(dir, '1.0.0', NOW - 25 * HOUR)

    const baseUrl = await downUrl()
    assert.equal(await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }), file)
    assert.deepEqual(await readState(dir), { version: '1.0.0', checkedAt: NOW })
  })

  it('replaces state.json with a rename instead of writing into it', async (t) => {
    const dir = await cacheDir(t)
    await seed(dir, '1.0.0', NOW - 25 * HOUR)
    const before = await stat(join(dir, 'state.json'))

    await ensureAppBinary({ baseUrl: await downUrl(), dir, hostKey: HOST_KEY, now: NOW })

    assert.notEqual((await stat(join(dir, 'state.json'))).ino, before.ino)
    assert.deepEqual(await readState(dir), { version: '1.0.0', checkedAt: NOW })
    assert.deepEqual(await readdir(dir), ['state.json', 'versions'])
  })

  it('refuses a download that stalls and leaves no file under versions/', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, {
      'manifest.json': manifest('1.0.0', gz),
      [FILE]: new Stalled(gz.subarray(0, 10))
    })
    const dir = await cacheDir(t)

    await assert.rejects(
      ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW, stallMs: 200 }),
      new RegExp(`Download of ${baseUrl}/${FILE} stalled`)
    )
    assert.deepEqual(await filesUnder(join(dir, 'versions')), [])
  })

  it('removes a stale partial download and keeps a fresh one', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gz), [FILE]: gz })
    const dir = await cacheDir(t)
    const versionDir = join(dir, 'versions', '1.0.0')
    await mkdir(versionDir, { recursive: true })
    const stale = join(versionDir, `${BINARY_NAME}.1.download`)
    const fresh = join(versionDir, `${BINARY_NAME}.2.download`)
    await writeFile(stale, '')
    await writeFile(fresh, '')
    await utimes(stale, new Date(NOW - 1000), new Date(NOW - 1000))
    await utimes(fresh, new Date(NOW), new Date(NOW))

    await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW, stallMs: 500 })

    assert.deepEqual((await readdir(versionDir)).sort(), [BINARY_NAME, `${BINARY_NAME}.2.download`])
  })

  it('gives up on a first run when the manifest never arrives', { timeout: 5000 }, async (t) => {
    const { baseUrl } = await serve(t, { 'manifest.json': new Stalled(Buffer.alloc(0)) })
    const dir = await cacheDir(t)

    await assert.rejects(
      ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW, stallMs: 200 }),
      new RegExp(`Could not fetch ${baseUrl}/manifest.json`)
    )
    assert.deepEqual(await filesUnder(dir), [])
  })

  it('runs the cached binary when an update download stalls', async (t) => {
    const gz = gzipSync(fakeBinary(0))
    const { baseUrl } = await serve(t, {
      'manifest.json': manifest('2.0.0', gz),
      [FILE]: new Stalled(gz.subarray(0, 10))
    })
    const dir = await cacheDir(t)
    const file = await seed(dir, '1.0.0', NOW - 25 * HOUR)

    const result = await ensureAppBinary({
      baseUrl,
      dir,
      hostKey: HOST_KEY,
      now: NOW,
      stallMs: 200
    })

    assert.equal(result, file)
    assert.deepEqual(await filesUnder(join(dir, 'versions', '2.0.0')), [])
  })

  it('exits 128 + 15 when the binary dies from SIGTERM', { skip: SKIP_EXEC }, async (t) => {
    const dir = await cacheDir(t)
    const file = join(dir, 'qvac')
    await writeFile(file, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM')\n`, {
      mode: 0o755
    })

    assert.equal(await runBinary(file, []), 143)
  })

  it(
    'runs the binary with a temp directory only this user can write to',
    { skip: SKIP_EXEC },
    async (t) => {
      const gz = gzipSync(`#!${process.execPath}\nconsole.log(process.env.TMPDIR)\n`)
      const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gz), [FILE]: gz })
      const dir = await cacheDir(t)

      const r = await runCli(['app'], { QVAC_APP_CLI_URL: baseUrl, QVAC_APP_CLI_DIR: dir })

      const tmp = join(dir, 'versions', '1.0.0', 'tmp')
      assert.equal(r.code, 0, r.stderr)
      assert.equal(r.stdout, `${tmp}\n`)
      const stats = await stat(tmp)
      assert.equal(stats.mode & 0o777, 0o700)
      assert.equal(stats.uid, process.getuid?.())
    }
  )

  it(
    'marks the version as in use while the binary runs and clears the mark after',
    { skip: SKIP_EXEC },
    async (t) => {
      const script = `console.log(process.ppid + ' ' + require('fs').readdirSync(__dirname + '/run').join())`
      const gz = gzipSync(`#!${process.execPath}\n${script}\n`)
      const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gz), [FILE]: gz })
      const dir = await cacheDir(t)

      const r = await runCli(['app'], { QVAC_APP_CLI_URL: baseUrl, QVAC_APP_CLI_DIR: dir })

      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stdout, /^(\d+) \1\n$/)
      assert.deepEqual(await readdir(join(dir, 'versions', '1.0.0', 'run')), [])
    }
  )

  it(
    'refuses a temp directory that others can write to and does not run the binary',
    { skip: SKIP_EXEC },
    async (t) => {
      const gz = gzipSync(fakeBinary(0))
      const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gz), [FILE]: gz })
      const dir = await cacheDir(t)
      const tmp = join(dir, 'versions', '1.0.0', 'tmp')
      await mkdir(tmp, { recursive: true })
      await chmod(tmp, 0o777)

      const r = await runCli(['app'], { QVAC_APP_CLI_URL: baseUrl, QVAC_APP_CLI_DIR: dir })

      assert.equal(r.code, 1)
      assert.equal(r.stdout, '')
      assert.ok(r.stderr.includes(`Refusing ${tmp}`), r.stderr)
    }
  )

  it(
    'refuses a temp directory that is a link or group-writable',
    { skip: SKIP_EXEC },
    async (t) => {
      const dir = await cacheDir(t)
      await mkdir(join(dir, 'real'))
      await symlink(join(dir, 'real'), join(dir, 'link'))
      await mkdir(join(dir, 'shared'))
      await chmod(join(dir, 'shared'), 0o770)

      await assert.rejects(privateTempDir(join(dir, 'link')), /Refusing/)
      await assert.rejects(privateTempDir(join(dir, 'shared')), /Refusing/)
      assert.equal(await privateTempDir(join(dir, 'real')), join(dir, 'real'))
    }
  )

  it('fails naming the URL when nothing is cached and the server is down', async (t) => {
    const dir = await cacheDir(t)
    const baseUrl = await downUrl()

    const r = await runCli(['app', '--version'], {
      QVAC_APP_CLI_URL: baseUrl,
      QVAC_APP_CLI_DIR: dir
    })

    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
    assert.ok(r.stderr.includes(`${baseUrl}/manifest.json`), r.stderr)
    assert.deepEqual(await filesUnder(dir), [])
  })

  it('lists the available hosts when there is no binary for this host', async (t) => {
    const { baseUrl } = await serve(t, { 'manifest.json': manifest('1.0.0', gzipSync('x')) })
    const dir = await cacheDir(t)

    await assert.rejects(
      ensureAppBinary({ baseUrl, dir, hostKey: 'plan9-mips', now: NOW }),
      new RegExp(`no binary for plan9-mips \\(available: ${HOST_KEY}\\)`)
    )
  })

  it('installs when the entry of another host is malformed', async (t) => {
    const body = fakeBinary(0)
    const gz = gzipSync(body)
    const { baseUrl } = await serve(t, {
      'manifest.json': manifest('1.0.0', gz, {
        'plan9-mips': { file: 'qvac-plan9-mips.zip' },
        'plan9-arm': 'soon'
      }),
      [FILE]: gz
    })
    const dir = await cacheDir(t)

    const file = await ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW })

    assert.equal(await readFile(file, 'utf8'), body)
  })

  describe('refuses an invalid manifest', () => {
    const gz = gzipSync(fakeBinary(0))
    const valid = entry(gz, 'qvac-bin.gz')
    const cases: Record<string, unknown> = {
      'not JSON': '{',
      'wrong shape': { schemaVersion: 1, version: '1.0.0', binaries: [] },
      'schemaVersion other than 1': {
        schemaVersion: 2,
        version: '1.0.0',
        binaries: { [HOST_KEY]: valid }
      },
      'version with a path separator': {
        schemaVersion: 1,
        version: 'a/b',
        binaries: { [HOST_KEY]: valid }
      },
      'version with ..': { schemaVersion: 1, version: '..', binaries: { [HOST_KEY]: valid } },
      'version with a space': { schemaVersion: 1, version: '1 0', binaries: { [HOST_KEY]: valid } },
      'file with a path separator': {
        schemaVersion: 1,
        version: '1.0.0',
        binaries: { [HOST_KEY]: { ...valid, file: '../qvac.gz' } }
      },
      'file with a backslash': {
        schemaVersion: 1,
        version: '1.0.0',
        binaries: { [HOST_KEY]: { ...valid, file: 'a\\qvac.gz' } }
      },
      'file that does not end in .gz': {
        schemaVersion: 1,
        version: '1.0.0',
        binaries: { [HOST_KEY]: { ...valid, file: 'qvac-bin' } }
      },
      'sha256 that is not 64 hex characters': {
        schemaVersion: 1,
        version: '1.0.0',
        binaries: { [HOST_KEY]: { ...valid, sha256: 'z'.repeat(64) } }
      }
    }

    for (const [name, value] of Object.entries(cases)) {
      it(name, async (t) => {
        const { baseUrl, requests } = await serve(t, { 'manifest.json': value, 'qvac-bin.gz': gz })
        const dir = await cacheDir(t)

        await assert.rejects(
          ensureAppBinary({ baseUrl, dir, hostKey: HOST_KEY, now: NOW }),
          /Invalid QV\.AC app CLI manifest/
        )
        assert.deepEqual(requests, ['/manifest.json'])
        assert.deepEqual(await filesUnder(dir), [])
      })
    }
  })

  it('refuses a non-local http: URL', () => {
    assert.throws(() => resolveBaseUrl('http://example.com/cli'), /only downloaded over https/)
    assert.equal(resolveBaseUrl('https://example.com/cli/'), 'https://example.com/cli')
    assert.equal(resolveBaseUrl('http://localhost:8080/cli'), 'http://localhost:8080/cli')
  })
})

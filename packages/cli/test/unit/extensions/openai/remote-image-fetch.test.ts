import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LookupAddress } from 'node:dns'
import {
  fetchRemoteImage,
  isBlockedAddress,
  RemoteImageFetchError,
  RemoteImageTooLargeError
} from '@/serve/lib/remote-image-fetch'
import type { RemoteImageFetchOptions } from '@/serve/lib/remote-image-fetch'

describe('isBlockedAddress', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.100.100.200',
    '169.254.169.254',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2001::1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'fe80::1%en0',
    'ff02::1',
    'not-an-ip'
  ]
  for (const address of blocked) {
    it(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true))
  }

  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.215.14',
    '172.32.0.1',
    '100.128.0.1',
    '::ffff:8.8.8.8',
    '2606:4700:4700::1111'
  ]
  for (const address of allowed) {
    it(`allows ${address}`, () => assert.equal(isBlockedAddress(address), false))
  }
})

// The test server listens on loopback, which the default guard refuses. Tests
// that need a reachable "public" host treat 127.0.0.1 as public and resolve
// test hostnames through a fake resolver; every other address keeps the real rule.
const PUBLIC_FOR_TEST = '127.0.0.1'

function testOptions(
  names: Record<string, string>,
  overrides: Partial<RemoteImageFetchOptions> = {}
): RemoteImageFetchOptions & { resolved: string[] } {
  const resolved: string[] = []
  return {
    maxBytes: 1024,
    timeoutMs: 2_000,
    isBlockedAddress: (address) => address !== PUBLIC_FOR_TEST && isBlockedAddress(address),
    resolve: (hostname, _opts, callback) => {
      resolved.push(hostname)
      const address = names[hostname]
      if (!address) {
        callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), [])
        return
      }
      const entry: LookupAddress = { address, family: address.includes(':') ? 6 : 4 }
      callback(null, [entry])
    },
    resolved,
    ...overrides
  }
}

async function assertFetchError(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof RemoteImageFetchError, `unexpected ${String(err)}`)
    assert.equal(err.message, 'could not fetch the image')
    return true
  })
}

describe('fetchRemoteImage', () => {
  let server: http.Server
  let port: number
  const hits: string[] = []
  const redirects = new Map<string, string>()

  // Redirect targets are registered by the test, never read from the request.
  function redirectPath(location: string): string {
    const path = `/redirect/${redirects.size}`
    redirects.set(path, location)
    return path
  }

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      const path = req.url ?? ''
      const location = redirects.get(path)
      if (path === '/image') {
        res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([1, 2, 3]))
      } else if (location) {
        res.writeHead(302, { location }).end()
      } else if (path === '/big') {
        res.writeHead(200).end(Buffer.alloc(4096))
      } else if (path === '/slow') {
        res.writeHead(200)
        res.write(Buffer.from([1]))
      } else {
        res.writeHead(Number(path.slice(1)) || 500).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  it('fetches an image from an allowed host', async () => {
    const opts = testOptions({ 'public.test': PUBLIC_FOR_TEST })
    const bytes = await fetchRemoteImage(`http://public.test:${port}/image`, opts)
    assert.deepEqual(bytes, new Uint8Array([1, 2, 3]))
  })

  it('follows a redirect to another allowed host', async () => {
    const opts = testOptions({ 'public.test': PUBLIC_FOR_TEST, 'cdn.test': PUBLIC_FOR_TEST })
    const path = redirectPath(`http://cdn.test:${port}/image`)
    const bytes = await fetchRemoteImage(`http://public.test:${port}${path}`, opts)
    assert.deepEqual(bytes, new Uint8Array([1, 2, 3]))
    assert.deepEqual(opts.resolved, ['public.test', 'cdn.test'])
  })

  it('refuses loopback with the default guard without connecting', async () => {
    const before = hits.length
    await assertFetchError(
      fetchRemoteImage(`http://127.0.0.1:${port}/image`, { maxBytes: 1024, timeoutMs: 2_000 })
    )
    await assertFetchError(
      fetchRemoteImage(`http://localhost:${port}/image`, { maxBytes: 1024, timeoutMs: 2_000 })
    )
    await assertFetchError(
      fetchRemoteImage(`http://[::ffff:127.0.0.1]:${port}/image`, {
        maxBytes: 1024,
        timeoutMs: 2_000
      })
    )
    assert.equal(hits.length, before)
  })

  it('refuses literal private and metadata addresses before resolving', async () => {
    for (const host of ['169.254.169.254', '10.0.0.1', '[fd00:ec2::254]', '2130706433']) {
      const opts = testOptions({})
      await assertFetchError(fetchRemoteImage(`http://${host}/latest/meta-data/`, opts))
      assert.deepEqual(opts.resolved, [])
    }
  })

  it('refuses a name that resolves to a blocked address at connect time', async () => {
    const opts = testOptions({ 'rebind.test': '169.254.169.254' })
    await assertFetchError(fetchRemoteImage(`http://rebind.test:${port}/image`, opts))
    assert.deepEqual(opts.resolved, ['rebind.test'])
  })

  it('refuses a name when any resolved address is blocked', async () => {
    const opts = testOptions({})
    opts.resolve = (_hostname, _o, callback) =>
      callback(null, [
        { address: PUBLIC_FOR_TEST, family: 4 },
        { address: '10.0.0.5', family: 4 }
      ])
    await assertFetchError(fetchRemoteImage(`http://mixed.test:${port}/image`, opts))
  })

  it('refuses a redirect to a blocked name or literal address', async () => {
    const opts = testOptions({ 'public.test': PUBLIC_FOR_TEST, 'internal.test': '10.0.0.7' })
    for (const to of [
      `http://internal.test:${port}/image`,
      'http://169.254.169.254/latest/meta-data/',
      `http://[::1]:${port}/image`,
      'file:///etc/passwd'
    ]) {
      await assertFetchError(
        fetchRemoteImage(`http://public.test:${port}${redirectPath(to)}`, opts)
      )
    }
  })

  it('stops after too many redirects', async () => {
    const opts = testOptions({ 'public.test': PUBLIC_FOR_TEST }, { maxRedirects: 1 })
    const inner = `http://public.test:${port}${redirectPath(`http://public.test:${port}/image`)}`
    const outer = `http://public.test:${port}${redirectPath(inner)}`
    await assertFetchError(fetchRemoteImage(outer, opts))
  })

  it('reports upstream status, timeout and connection failure identically', async () => {
    const opts = testOptions({ 'public.test': PUBLIC_FOR_TEST }, { timeoutMs: 300 })
    await assertFetchError(fetchRemoteImage(`http://public.test:${port}/404`, opts))
    await assertFetchError(fetchRemoteImage(`http://public.test:${port}/500`, opts))
    await assertFetchError(fetchRemoteImage(`http://public.test:${port}/slow`, opts))
    await assertFetchError(fetchRemoteImage(`http://public.test:1/image`, opts))
    await assertFetchError(fetchRemoteImage(`http://missing.test:${port}/image`, opts))
  })

  it('enforces the size limit', async () => {
    const opts = testOptions({ 'public.test': PUBLIC_FOR_TEST })
    await assert.rejects(
      fetchRemoteImage(`http://public.test:${port}/big`, opts),
      RemoteImageTooLargeError
    )
  })
})

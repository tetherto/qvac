import { expect, test } from 'bun:test'
import * as Harness from '../lib/weather-proxy.ts'

const ALLOWED_URL = 'https://wttr.in/London?format=3'
const NON_PUBLIC_ADDRESSES: readonly (readonly [string, 4 | 6])[] = [
  ['127.0.0.1', 4],
  ['10.0.0.1', 4],
  ['169.254.1.1', 4],
  ['192.0.2.1', 4],
  ['::1', 6],
  ['fe80::1', 6],
  ['fc00::1', 6],
  ['2001:db8::1', 6]
]

test.each([
  ['http://wttr.in/London?format=3', /HTTPS/i],
  ['https://evil.example/London?format=3', /wttr\.in/i],
  ['https://wttr.in.evil.example/London?format=3', /wttr\.in/i],
  ['https://wttr.in./London?format=3', /wttr\.in/i],
  ['https://user:pass@wttr.in/London?format=3', /credentials/i],
  ['https://wttr.in:444/London?format=3', /port/i],
  ['https://wttr.in/London?format=3#fragment', /fragment/i]
])('Weather rejects normalized URL bypass %s', (url, message) => {
  const validate = Reflect.get(Harness, 'validateWeatherRequest')
  expect(typeof validate).toBe('function')
  if (typeof validate !== 'function') return

  expect(validate({ url, method: 'GET' })).toEqual({
    ok: false,
    error: expect.stringMatching(message)
  })
})

test('Weather accepts only a credential-free GET with exact input keys', () => {
  const validate = Reflect.get(Harness, 'validateWeatherRequest')
  expect(typeof validate).toBe('function')
  if (typeof validate !== 'function') return

  expect(validate({ url: 'https://WTTR.IN/London?format=3', method: 'GET' })).toEqual({
    ok: true,
    url: ALLOWED_URL
  })
  expect(validate({ url: ALLOWED_URL, method: 'POST' })).toEqual({
    ok: false,
    error: expect.stringMatching(/GET/i)
  })
  expect(validate({ url: ALLOWED_URL, method: 'GET', headers: { accept: '*/*' } })).toEqual({
    ok: false,
    error: expect.stringMatching(/unsupported.*headers/i)
  })
  expect(validate({ url: ALLOWED_URL, method: 'GET', body: 'x' })).toEqual({
    ok: false,
    error: expect.stringMatching(/unsupported.*body/i)
  })
})

test('Weather proxy authenticates callers and revalidates every redirect', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  const seen: string[] = []
  const proxy = await createProxy({
    token: 'fixture-weather-token',
    async fetch(url: URL) {
      seen.push(url.href)
      return {
        status: 302,
        headers: { location: 'https://evil.example/stolen' },
        body: ''
      }
    }
  })

  try {
    const unauthenticated = await proxyRequest(proxy.port, ALLOWED_URL)
    expect(unauthenticated.status).toBe(401)

    const response = await proxyRequest(
      proxy.port,
      ALLOWED_URL,
      'fixture-weather-token'
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: expect.stringMatching(/wttr\.in/i)
    })
    expect(seen).toEqual([ALLOWED_URL])
  } finally {
    await proxy.close()
  }
})

test('Weather proxy issues stable distinct credentials per agent', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  const proxy = await createProxy({
    async resolve() {
      return [{ address: '1.1.1.1', family: 4 }]
    },
    async fetch() {
      return { status: 200, headers: {}, body: 'ok' }
    }
  })
  try {
    const agentA = proxy.tokenForAgent('agent-a')
    const agentB = proxy.tokenForAgent('agent-b')
    expect(agentA).toBe(proxy.tokenForAgent('agent-a'))
    expect(agentA).not.toBe(agentB)
    expect(
      (await proxyRequestForAgent(proxy.port, 'agent-a', ALLOWED_URL, agentA))
        .status
    ).toBe(200)
    expect(
      (await proxyRequestForAgent(proxy.port, 'agent-b', ALLOWED_URL, agentB))
        .status
    ).toBe(200)
    expect(
      (await proxyRequest(proxy.port, ALLOWED_URL, 'unissued-token')).status
    ).toBe(401)
  } finally {
    await proxy.close()
  }
})

test('Weather proxy token is fenced to its owning agent route', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  const proxy = await createProxy({
    async resolve() {
      return [{ address: '1.1.1.1', family: 4 }]
    },
    async fetch() {
      return { status: 200, headers: {}, body: 'ok' }
    }
  })
  try {
    const agentAToken = proxy.tokenForAgent('agent-a')
    expect(
      (
        await proxyRequestForAgent(
          proxy.port,
          'agent-a',
          ALLOWED_URL,
          agentAToken
        )
      ).status
    ).toBe(200)
    expect(
      (
        await proxyRequestForAgent(
          proxy.port,
          'agent-b',
          ALLOWED_URL,
          agentAToken
        )
      ).status
    ).toBe(401)
  } finally {
    await proxy.close()
  }
})

test.each(NON_PUBLIC_ADDRESSES)('Weather rejects non-public resolved address %s', async (address, family) => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  let fetched = false
  const proxy = await createProxy({
    token: 'dns-token',
    async resolve() {
      return [{ address, family }]
    },
    async fetch() {
      fetched = true
      return { status: 200, headers: {}, body: 'unsafe' }
    }
  })
  try {
    const response = await proxyRequest(proxy.port, ALLOWED_URL, 'dns-token')
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: expect.stringMatching(/public address/i)
    })
    expect(fetched).toBe(false)
  } finally {
    await proxy.close()
  }
})

test('Weather resolves and pins a public address for every redirect hop', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  const resolutions: string[] = []
  const pinned: string[] = []
  let calls = 0
  const proxy = await createProxy({
    token: 'pin-token',
    async resolve(hostname: string) {
      resolutions.push(hostname)
      return [{ address: calls === 0 ? '1.1.1.1' : '8.8.8.8', family: 4 }]
    },
    async fetch(_url: URL, _signal: AbortSignal, _limit: number, address: { address: string }) {
      pinned.push(address.address)
      calls++
      if (calls === 1) {
        return {
          status: 302,
          headers: { location: '/Paris?format=3' },
          body: ''
        }
      }
      return { status: 200, headers: {}, body: 'public' }
    }
  })
  try {
    const response = await proxyRequest(proxy.port, ALLOWED_URL, 'pin-token')
    expect(await response.json()).toEqual({ status: 200, body: 'public' })
    expect(resolutions).toEqual(['wttr.in', 'wttr.in'])
    expect(pinned).toEqual(['1.1.1.1', '8.8.8.8'])
  } finally {
    await proxy.close()
  }
})

test('Weather deterministically prefers public IPv4 then falls back to IPv6', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  const selected: string[] = []
  const dualStack = await createProxy({
    async resolve() {
      return [
        { address: '2606:4700:4700::1111', family: 6 },
        { address: '9.9.9.9', family: 4 },
        { address: '1.1.1.1', family: 4 }
      ]
    },
    async fetch(_url: URL, _signal: AbortSignal, _limit: number, address: { address: string }) {
      selected.push(address.address)
      return { status: 200, headers: {}, body: 'ipv4' }
    }
  })
  const ipv6Only = await createProxy({
    async resolve() {
      return [
        { address: '2606:4700:4700::1112', family: 6 },
        { address: '2606:4700:4700::1111', family: 6 }
      ]
    },
    async fetch(_url: URL, _signal: AbortSignal, _limit: number, address: { address: string }) {
      selected.push(address.address)
      return { status: 200, headers: {}, body: 'ipv6' }
    }
  })
  try {
    const firstToken = dualStack.tokenForAgent('dual-stack')
    const secondToken = ipv6Only.tokenForAgent('ipv6-only')
    expect(
      (
        await proxyRequestForAgent(
          dualStack.port,
          'dual-stack',
          ALLOWED_URL,
          firstToken
        )
      ).status
    ).toBe(200)
    expect(
      (
        await proxyRequestForAgent(
          ipv6Only.port,
          'ipv6-only',
          ALLOWED_URL,
          secondToken
        )
      ).status
    ).toBe(200)
    expect(selected).toEqual(['1.1.1.1', '2606:4700:4700::1111'])
  } finally {
    await Promise.all([dualStack.close(), ipv6Only.close()])
  }
})

test('Weather proxy follows same-origin redirects manually and caps redirect count', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  const redirected = await createProxy({
    token: 'redirect-token',
    maxRedirects: 2,
    async fetch(url: URL) {
      if (url.pathname === '/first') {
        return {
          status: 302,
          headers: { location: '/second?format=3' },
          body: ''
        }
      }
      return { status: 200, headers: {}, body: 'redirect-ok' }
    }
  })
  const looping = await createProxy({
    token: 'loop-token',
    maxRedirects: 1,
    async fetch() {
      return {
        status: 302,
        headers: { location: '/again?format=3' },
        body: ''
      }
    }
  })

  try {
    const followed = await proxyRequest(
      redirected.port,
      'https://wttr.in/first?format=3',
      'redirect-token'
    )
    expect(await followed.json()).toEqual({
      status: 200,
      body: 'redirect-ok'
    })

    const capped = await proxyRequest(
      looping.port,
      ALLOWED_URL,
      'loop-token'
    )
    expect(capped.status).toBe(400)
    expect(await capped.json()).toEqual({
      error: expect.stringMatching(/too many redirects/i)
    })
  } finally {
    await Promise.all([redirected.close(), looping.close()])
  }
})

test('Weather proxy caps response bytes and request duration', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  let timedOut = false
  const capped = await createProxy({
    token: 'cap-token',
    maxResponseBytes: 8,
    async fetch() {
      return { status: 200, headers: {}, body: '123456789' }
    }
  })
  const slow = await createProxy({
    token: 'timeout-token',
    timeoutMs: 10,
    async fetch(_url: URL, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            timedOut = true
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true }
        )
      })
      return { status: 200, headers: {}, body: '' }
    }
  })

  try {
    const cappedResponse = await proxyRequest(capped.port, ALLOWED_URL, 'cap-token')
    expect(cappedResponse.status).toBe(413)
    expect(await cappedResponse.json()).toEqual({
      error: expect.stringMatching(/response.*limit/i)
    })

    const timeoutResponse = await proxyRequest(
      slow.port,
      ALLOWED_URL,
      'timeout-token'
    )
    expect(timeoutResponse.status).toBe(504)
    expect(await timeoutResponse.json()).toEqual({
      error: expect.stringMatching(/timed out/i)
    })
    expect(timedOut).toBe(true)
  } finally {
    await Promise.all([capped.close(), slow.close()])
  }
})

test('Weather proxy rejects response limits above the configured hard cap', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  await expect(
    createProxy({ maxResponseBytes: 65_537 })
  ).rejects.toThrow(/must not exceed 65536/i)
})

test('Weather proxy propagates caller cancellation and closes active requests', async () => {
  const createProxy = Reflect.get(Harness, 'createWeatherProxy')
  expect(typeof createProxy).toBe('function')
  if (typeof createProxy !== 'function') return

  let upstreamAborted = false
  const proxy = await createProxy({
    token: 'cancel-token',
    timeoutMs: 5_000,
    async fetch(_url: URL, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            upstreamAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true }
        )
      })
      return { status: 200, headers: {}, body: '' }
    }
  })
  const controller = new AbortController()
  const pending = fetch(proxyUrl(proxy.port, ALLOWED_URL), {
    headers: { authorization: 'Bearer cancel-token' },
    signal: controller.signal
  }).catch((error: Error) => error)
  await Bun.sleep(10)
  controller.abort()
  await pending
  await waitFor(() => upstreamAborted)

  const closing = createProxy({
    token: 'close-token',
    timeoutMs: 5_000,
    async fetch(_url: URL, signal: AbortSignal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            upstreamAborted = true
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true }
        )
      })
      return { status: 200, headers: {}, body: '' }
    }
  })
  const closeProxy = await closing
  const active = proxyRequest(closeProxy.port, ALLOWED_URL, 'close-token').catch(
    (error: Error) => error
  )
  await Bun.sleep(10)
  upstreamAborted = false
  await closeProxy.close()
  await active
  expect(upstreamAborted).toBe(true)

  await proxy.close()
})

function proxyRequest(port: number, url: string, token?: string) {
  return fetch(proxyUrl(port, url), {
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {})
  })
}

function proxyRequestForAgent(
  port: number,
  agentId: string,
  url: string,
  token: string
) {
  return fetch(
    `http://127.0.0.1:${port}/agents/${encodeURIComponent(agentId)}/request?url=${encodeURIComponent(url)}`,
    { headers: { authorization: `Bearer ${token}` } }
  )
}

function proxyUrl(port: number, url: string) {
  return `http://127.0.0.1:${port}/agents/test-agent/request?url=${encodeURIComponent(url)}`
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(5)
  }
}

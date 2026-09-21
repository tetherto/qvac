'use strict'

const test = require('brittle')
const crypto = require('crypto')
const IdEnc = require('hypercore-id-encoding')
const {
  connectToRegistryByCapacity,
  parseAvailableBytes,
  selectPeerByCapacity
} = require('../../scripts/utils/rpc-client')

const noopLogger = {
  info() {},
  warn() {}
}

test('connectToRegistryByCapacity probes each peer once and connects to the winner', async (t) => {
  const peerKeys = [randomPeerKey(), randomPeerKey(), randomPeerKey()]
  const capacities = new Map([
    [peerKeys[0], '100'],
    [peerKeys[1], '300'],
    [peerKeys[2], '200']
  ])
  const calls = []
  const cleaned = []
  const selectedConnection = { peerKey: peerKeys[1] }

  const result = await connectToRegistryByCapacity({
    config: { getIndexerKeys: () => peerKeys },
    logger: noopLogger,
    connect: (opts) => {
      calls.push(opts)
      if (calls.length > peerKeys.length) return Promise.resolve(selectedConnection)

      return Promise.resolve({
        rpc: {
          request: () => Promise.resolve({ availableBytes: capacities.get(opts.targetPeer) })
        },
        cleanup: () => {
          cleaned.push(opts.targetPeer)
          return Promise.resolve()
        }
      })
    }
  })

  t.is(result, selectedConnection)
  t.alike(
    calls.slice(0, 3).map((call) => call.targetPeer),
    peerKeys
  )
  t.is(calls[3].targetPeer, peerKeys[1])
  t.alike(cleaned, peerKeys)
})

test('connectToRegistryByCapacity does not hide writer authorization failures', async (t) => {
  const peerKey = randomPeerKey()
  let cleaned = false
  const warnings = []

  try {
    await connectToRegistryByCapacity({
      config: { getIndexerKeys: () => [peerKey] },
      logger: {
        info() {},
        warn(context, message) {
          warnings.push({ context, message })
        }
      },
      connect: () =>
        Promise.resolve({
          rpc: {
            request: () => {
              const cause = new Error('Unauthorized writer RPC request')
              cause.code = 'ERR_WRITER_UNAUTHORIZED'
              const err = new Error('Request failed', { cause })
              err.code = 'REQUEST_ERROR'
              return Promise.reject(err)
            }
          },
          cleanup: () => {
            cleaned = true
            return Promise.resolve()
          }
        })
    })
    t.fail('Expected writer authorization failure')
  } catch (err) {
    t.is(err.cause.code, 'ERR_WRITER_UNAUTHORIZED')
    t.ok(cleaned)
    t.is(warnings[0].context.peer, peerKey)
    t.is(warnings[0].context.code, 'ERR_WRITER_UNAUTHORIZED')
  }
})

test('connectToRegistryByCapacity uses legacy selection when every probe fails', async (t) => {
  const peerKeys = [randomPeerKey(), randomPeerKey()]
  const calls = []
  const cleaned = []
  const fallbackConnection = { peerKey: peerKeys[0] }

  const result = await connectToRegistryByCapacity({
    config: { getIndexerKeys: () => peerKeys },
    logger: noopLogger,
    connect: (opts) => {
      calls.push(opts)
      if (!opts.targetPeer) return Promise.resolve(fallbackConnection)

      return Promise.resolve({
        rpc: {
          request: () => Promise.reject(new Error('Capacity unavailable'))
        },
        cleanup: () => {
          cleaned.push(opts.targetPeer)
          return Promise.resolve()
        }
      })
    }
  })

  t.is(result, fallbackConnection)
  t.alike(
    calls.slice(0, peerKeys.length).map((call) => call.targetPeer),
    peerKeys
  )
  t.absent(calls[peerKeys.length].targetPeer)
  t.alike(cleaned, peerKeys)
})

test('selectPeerByCapacity chooses the peer with the most available bytes', (t) => {
  const selected = selectPeerByCapacity([
    { peerKey: 'peer-a', availableBytes: '100' },
    { peerKey: 'peer-b', availableBytes: '300' },
    { peerKey: 'peer-c', availableBytes: '200' }
  ])

  t.is(selected.peerKey, 'peer-b')
  t.is(selected.availableBytes, 300n)
})

test('selectPeerByCapacity breaks equal-capacity ties by peer key', (t) => {
  const selected = selectPeerByCapacity([
    { peerKey: 'peer-c', availableBytes: '300' },
    { peerKey: 'peer-a', availableBytes: '300' },
    { peerKey: 'peer-b', availableBytes: '300' }
  ])

  t.is(selected.peerKey, 'peer-a')
})

test('selectPeerByCapacity ignores malformed capacity values', (t) => {
  const selected = selectPeerByCapacity([
    { peerKey: 'negative', availableBytes: '-1' },
    { peerKey: 'fractional', availableBytes: 1.5 },
    { peerKey: 'missing' },
    { peerKey: 'valid', availableBytes: '42' }
  ])

  t.is(selected.peerKey, 'valid')
  t.is(selectPeerByCapacity([{ peerKey: 'invalid', availableBytes: 'many' }]), null)
})

test('parseAvailableBytes preserves integers larger than Number.MAX_SAFE_INTEGER', (t) => {
  t.is(parseAvailableBytes('18446744073709551615'), 18446744073709551615n)
  t.is(parseAvailableBytes(Number.MAX_SAFE_INTEGER + 1), null)
})

function randomPeerKey() {
  return IdEnc.normalize(crypto.randomBytes(32))
}

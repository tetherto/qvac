import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { buildServer } from '@/serve/index'
import { identityProof } from '@/serve/core/identity'

const API_KEY = 'identity-test-key-0123456789'

async function listening(apiKey?: string) {
  const app = await buildServer({ projectRoot: tmpdir(), port: 0, host: '127.0.0.1', apiKey })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  return { app, port, base: `http://127.0.0.1:${port}` }
}

describe('serve identity challenge', () => {
  it('proves the key for the bound port without requiring the key', async () => {
    const { app, port, base } = await listening(API_KEY)
    try {
      const nonce = randomBytes(32).toString('base64url')
      const res = await fetch(`${base}/qvac/identity?nonce=${nonce}`)
      assert.equal(res.status, 200)
      const { proof } = (await res.json()) as { proof: string }
      assert.equal(proof, identityProof(API_KEY, nonce, port))
      assert.notEqual(proof, identityProof(API_KEY, nonce, port + 1))
      assert.notEqual(proof, identityProof('another-key-0123456789', nonce, port))
    } finally {
      await app.close()
    }
  })

  it('rejects a malformed nonce', async () => {
    const { app, base } = await listening(API_KEY)
    try {
      const res = await fetch(`${base}/qvac/identity?nonce=short`)
      assert.equal(res.status, 400)
    } finally {
      await app.close()
    }
  })

  it('is absent when the server has no key', async () => {
    const { app, base } = await listening()
    try {
      const nonce = randomBytes(32).toString('base64url')
      const res = await fetch(`${base}/qvac/identity?nonce=${nonce}`)
      assert.equal(res.status, 404)
    } finally {
      await app.close()
    }
  })

  it('still rejects a wrong key of the same length', async () => {
    const { app, base } = await listening(API_KEY)
    try {
      const wrong = 'x'.repeat(API_KEY.length)
      const res = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${wrong}` }
      })
      assert.equal(res.status, 401)
      const ok = await fetch(`${base}/v1/models`, {
        headers: { authorization: `Bearer ${API_KEY}` }
      })
      assert.equal(ok.status, 200)
    } finally {
      await app.close()
    }
  })
})

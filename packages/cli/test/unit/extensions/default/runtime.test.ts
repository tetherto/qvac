import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import type { FastifyInstance } from 'fastify'
import type { LifecycleState, LoadedModelInfo } from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import { runtimeRoutes, type RuntimeOperations } from '@/serve/extensions/default/routes/runtime'

interface Fake {
  state: LifecycleState
  failSuspend: boolean
  failResume: boolean
  suspendLatch?: Promise<void>
}

function fakeOperations(fake: Fake): RuntimeOperations {
  /* lunte-disable require-await */
  return {
    state: async () => fake.state,
    suspend: async () => {
      await fake.suspendLatch
      fake.state = 'suspended'
      if (fake.failSuspend) throw new Error('swarm refused')
    },
    resume: async () => {
      if (fake.failResume) throw new Error('corestore refused')
      fake.state = 'active'
    },
    getLoadedModelInfo: async ({ modelId }): Promise<LoadedModelInfo> => ({
      modelId,
      modelType: 'llm',
      handlers: ['completionStream'],
      addonPackage: '@qvac/llm-llamacpp',
      loadedAt: new Date(1_760_000_000_000),
      path: '/home/someone/.qvac/models/secret.gguf'
    })
  }
  /* lunte-enable require-await */
}

async function server(
  fake: Fake,
  enableAdmin: boolean,
  corsOrigins?: string[],
  apiKey?: string
): Promise<FastifyInstance> {
  const app = await buildServer({
    projectRoot: tmpdir(),
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    extensions: [],
    enableAdmin,
    corsOrigins,
    apiKey
  })
  await app.register(runtimeRoutes(fakeOperations(fake)))
  // lunte-disable-next-line require-await
  app.get('/probe', async () => ({ ok: true }))
  await app.ready()
  return app
}

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

describe('runtime routes without --enable-admin', () => {
  const fake: Fake = { state: 'active', failSuspend: false, failResume: false }
  let app: FastifyInstance
  before(async () => {
    app = await server(fake, false)
  })
  after(async () => {
    await app.close()
  })

  it('reads the state', async () => {
    const res = await app.inject({ method: 'GET', url: '/qvac/v1/runtime/state' })
    assert.equal(res.statusCode, 200, res.payload)
    assert.deepEqual(res.json(), { object: 'runtime.state', state: 'active' })
  })

  it('refuses suspend and resume with 403 admin_disabled and leaves the runtime alone', async () => {
    for (const url of ['/qvac/v1/runtime/suspend', '/qvac/v1/runtime/resume']) {
      const res = await app.inject({ method: 'POST', url })
      assert.equal(res.statusCode, 403, url)
      assert.equal(code(res), 'admin_disabled')
    }
    assert.equal(fake.state, 'active')
  })
})

describe('runtime routes with --enable-admin', () => {
  const fake: Fake = { state: 'active', failSuspend: false, failResume: false }
  let app: FastifyInstance
  before(async () => {
    app = await server(fake, true)
  })
  after(async () => {
    await app.close()
  })
  beforeEach(async () => {
    fake.failSuspend = false
    fake.failResume = false
    await app.inject({ method: 'POST', url: '/qvac/v1/runtime/resume' })
  })

  it('suspends, gates every route but the runtime ones with 503, and resumes', async () => {
    const suspended = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/suspend' })
    assert.equal(suspended.statusCode, 200, suspended.payload)
    assert.deepEqual(suspended.json(), { object: 'runtime.state', state: 'suspended' })

    const probe = await app.inject({ method: 'GET', url: '/probe' })
    assert.equal(probe.statusCode, 503)
    assert.equal(code(probe), 'runtime_suspended')
    const models = await app.inject({ method: 'GET', url: '/qvac/v1/runtime/models' })
    assert.equal(code(models), 'runtime_suspended')

    const state = await app.inject({ method: 'GET', url: '/qvac/v1/runtime/state' })
    assert.equal((state.json() as { state: string }).state, 'suspended')
    assert.equal((await app.inject({ method: 'GET', url: '/openapi.json' })).statusCode, 200)

    const resumed = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/resume' })
    assert.deepEqual(resumed.json(), { object: 'runtime.state', state: 'active' })
    assert.equal((await app.inject({ method: 'GET', url: '/probe' })).statusCode, 200)
  })

  it('gates requests while the suspend is still running', async () => {
    let release = (): void => {}
    fake.suspendLatch = new Promise((resolve) => {
      release = resolve
    })
    try {
      const suspending = app.inject({ method: 'POST', url: '/qvac/v1/runtime/suspend' })
      await new Promise((resolve) => setImmediate(resolve))
      const probe = await app.inject({ method: 'GET', url: '/probe' })
      assert.equal(probe.statusCode, 503)
      assert.match(probe.payload, /suspending/)
      release()
      assert.equal((await suspending).statusCode, 200)
    } finally {
      release()
      delete fake.suspendLatch
    }
  })

  it('reports a partial suspend as 500 and still gates requests', async () => {
    fake.failSuspend = true
    const res = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/suspend' })
    assert.equal(res.statusCode, 500)
    assert.equal(code(res), 'runtime_suspend_failed')
    assert.doesNotMatch(res.payload, /swarm refused/)
    assert.equal((await app.inject({ method: 'GET', url: '/probe' })).statusCode, 503)
  })

  it('reports a failed resume as 500 and stays suspended', async () => {
    await app.inject({ method: 'POST', url: '/qvac/v1/runtime/suspend' })
    fake.failResume = true
    const res = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/resume' })
    assert.equal(res.statusCode, 500)
    assert.equal(code(res), 'runtime_resume_failed')
    assert.equal((await app.inject({ method: 'GET', url: '/probe' })).statusCode, 503)
  })

  it('lists only loaded aliases, without the on-disk path', async () => {
    const { registry } = app.qvac
    const opts = { modelSrc: 'x', sdkType: 'llm', endpointCategory: 'chat', config: {} }
    registry.register('ready-llm', opts)
    registry.setReady('ready-llm', 'sdk-ready')
    registry.register('idle-llm', opts)

    const res = await app.inject({ method: 'GET', url: '/qvac/v1/runtime/models' })
    assert.equal(res.statusCode, 200, res.payload)
    assert.deepEqual(res.json(), {
      object: 'list',
      data: [
        {
          object: 'runtime.model',
          model: 'ready-llm',
          modelId: 'sdk-ready',
          modelType: 'llm',
          handlers: ['completionStream'],
          addonPackage: '@qvac/llm-llamacpp',
          loadedAt: 1_760_000_000_000
        }
      ]
    })
  })
})

describe('runtime admin routes and the request Origin', () => {
  const fake: Fake = { state: 'active', failSuspend: false, failResume: false }
  let app: FastifyInstance
  before(async () => {
    app = await server(fake, true, ['https://app.example.com'])
  })
  after(async () => {
    await app.close()
  })
  beforeEach(async () => {
    await app.inject({ method: 'POST', url: '/qvac/v1/runtime/resume' })
  })

  it('refuses a browser request from an origin outside the CORS allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/qvac/v1/runtime/suspend',
      headers: { origin: 'https://evil.example' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(code(res), 'origin_not_allowed')
    assert.equal(fake.state, 'active')
  })

  it('accepts an allowlisted origin and a request with no Origin', async () => {
    const allowed = await app.inject({
      method: 'POST',
      url: '/qvac/v1/runtime/suspend',
      headers: { origin: 'https://app.example.com' }
    })
    assert.equal(allowed.statusCode, 200, allowed.payload)
    const plain = await app.inject({ method: 'POST', url: '/qvac/v1/runtime/resume' })
    assert.equal(plain.statusCode, 200, plain.payload)
  })

  it('leaves the read-only routes open to any origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/qvac/v1/runtime/state',
      headers: { origin: 'https://evil.example' }
    })
    assert.equal(res.statusCode, 200, res.payload)
  })
})

describe('runtime routes behind an API key', () => {
  const KEY = 'test-key'
  const auth = { authorization: `Bearer ${KEY}` }

  for (const enableAdmin of [false, true]) {
    it(`answers 401 before the admin check with --enable-admin ${enableAdmin ? 'on' : 'off'}`, async () => {
      const fake: Fake = { state: 'active', failSuspend: false, failResume: false }
      const app = await server(fake, enableAdmin, undefined, KEY)
      try {
        for (const url of ['/qvac/v1/runtime/suspend', '/qvac/v1/runtime/resume']) {
          const res = await app.inject({ method: 'POST', url })
          assert.equal(res.statusCode, 401, url)
          assert.equal(code(res), 'invalid_api_key')
        }
        assert.equal(fake.state, 'active')
      } finally {
        await app.close()
      }
    })
  }

  it('answers 401 before the suspended gate', async () => {
    const fake: Fake = { state: 'active', failSuspend: false, failResume: false }
    const app = await server(fake, true, undefined, KEY)
    try {
      const suspended = await app.inject({
        method: 'POST',
        url: '/qvac/v1/runtime/suspend',
        headers: auth
      })
      assert.equal(suspended.statusCode, 200, suspended.payload)

      const anonymous = await app.inject({ method: 'GET', url: '/probe' })
      assert.equal(anonymous.statusCode, 401)
      assert.equal(code(anonymous), 'invalid_api_key')
      const keyed = await app.inject({ method: 'GET', url: '/probe', headers: auth })
      assert.equal(code(keyed), 'runtime_suspended')
    } finally {
      await app.close()
    }
  })
})

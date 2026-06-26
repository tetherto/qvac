import type { FastifyInstance } from 'fastify'
import { before, after, type TestContext } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer, type StartServerOptions } from '../../../src/serve/index.js'
import { preloadModels } from '../../../src/serve/core/lifecycle.js'
import { MODELLESS_CONFIG, writeConfigDir } from './config.js'
// Side-effect import: augments FastifyInstance with `.qvac`.
import '../../../src/serve/lib/types.js'

export interface CreateServerOptions {
  config?: unknown
  apiKey?: string
  cors?: boolean
  publicBaseUrl?: string
  docs?: boolean
  model?: string[]
}

function serverOptions(projectRoot: string, opts: CreateServerOptions): StartServerOptions {
  return {
    projectRoot,
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.cors !== undefined ? { cors: opts.cors } : {}),
    ...(opts.publicBaseUrl !== undefined ? { publicBaseUrl: opts.publicBaseUrl } : {}),
    ...(opts.docs !== undefined ? { docs: opts.docs } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {})
  }
}

// Build an in-process server (no listen) against a temp projectRoot. Returns
// the Fastify app; call app.inject(...) to drive it. Closes on test teardown.
export async function createServer(
  t: TestContext,
  opts: CreateServerOptions = {}
): Promise<FastifyInstance> {
  const projectRoot = await writeConfigDir(t, opts.config ?? MODELLESS_CONFIG)
  const app = await buildServer(serverOptions(projectRoot, opts))
  t.after(async () => {
    await app.close()
  })
  return app
}

// Build one shared server per describe block (one server per config variant).
// Wires before/after on the enclosing suite and returns a getter for use inside
// `it` bodies.
export function useServer(opts: CreateServerOptions = {}): () => FastifyInstance {
  let app: FastifyInstance | undefined
  let dir: string | undefined
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qvac-cli-e2e-'))
    await writeFile(join(dir, 'qvac.config.json'), JSON.stringify(opts.config ?? MODELLESS_CONFIG))
    app = await buildServer(serverOptions(dir, opts))
  })
  after(async () => {
    if (app !== undefined) await app.close()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })
  return () => {
    if (app === undefined) throw new Error('useServer: server not started (called outside a test?)')
    return app
  }
}

// Like useServer, but preloads real models in-process (build + ready +
// preloadModels). No listen and no close-with-grace signal handlers — those
// would interfere with the test runner.
// One shared server per file, since model loads are expensive and node:test
// isolates files into separate processes.
export function useModelServer(config: unknown): () => FastifyInstance {
  let app: FastifyInstance | undefined
  let dir: string | undefined
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qvac-cli-e2e-models-'))
    await writeFile(join(dir, 'qvac.config.json'), JSON.stringify(config))
    app = await buildServer(serverOptions(dir, {}))
    await app.ready()
    await preloadModels(app.qvac.serveConfig, app.qvac.registry, app.qvac.logger)
    // preloadModels swallows per-model errors; fail loudly if a preload model
    // didn't reach READY so a load failure isn't seen as confusing 404s.
    for (const [alias, entry] of app.qvac.serveConfig.models) {
      if (!entry.preload) continue
      const e = app.qvac.registry.getEntry(alias)
      if (e?.state !== app.qvac.registry.STATES.READY) {
        throw new Error(
          `preload failed for "${alias}": state=${e?.state ?? 'missing'} error=${e?.error ?? 'none'}`
        )
      }
    }
  })
  after(async () => {
    if (app !== undefined) await app.close()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })
  return () => {
    if (app === undefined) {
      throw new Error('useModelServer: server not started (called outside a test?)')
    }
    return app
  }
}

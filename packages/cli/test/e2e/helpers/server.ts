import type { FastifyInstance } from 'fastify'
import { before, after, type TestContext } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer, type StartServerOptions } from '../../../src/serve/index.js'
import { MODELLESS_CONFIG, writeConfigDir } from './config.js'

export interface CreateServerOptions {
  config?: unknown
  apiKey?: string
  cors?: boolean
  publicBaseUrl?: string
  docs?: boolean
  model?: string[]
}

function serverOptions (projectRoot: string, opts: CreateServerOptions): StartServerOptions {
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
export async function createServer (t: TestContext, opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const projectRoot = await writeConfigDir(t, opts.config ?? MODELLESS_CONFIG)
  const app = await buildServer(serverOptions(projectRoot, opts))
  t.after(async () => { await app.close() })
  return app
}

// Build one shared server for a describe block (mirrors the bats setup_file
// model of a server per config variant). Wires before/after on the enclosing
// suite and returns a getter for use inside `it` bodies.
export function useServer (opts: CreateServerOptions = {}): () => FastifyInstance {
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

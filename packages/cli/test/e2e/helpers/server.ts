import type { FastifyInstance } from 'fastify'
import type { TestContext } from 'node:test'
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

// Build an in-process server (no listen) against a temp projectRoot. Returns
// the Fastify app; call app.inject(...) to drive it. Closes on test teardown.
export async function createServer (t: TestContext, opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const projectRoot = await writeConfigDir(t, opts.config ?? MODELLESS_CONFIG)
  const options: StartServerOptions = {
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
  const app = await buildServer(options)
  t.after(async () => { await app.close() })
  return app
}

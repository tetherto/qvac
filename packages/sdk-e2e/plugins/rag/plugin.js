import { z } from 'zod'
import fs from 'bare-fs'
import AbortController from 'bare-abort-controller'
import os from 'bare-os'
import path from 'bare-path'
import { definePlugin, defineHandler } from '@qvac/sdk'
import { embed } from '@qvac/inference'
import { createRagOps, RAG_OPS } from './ops.js'

// Runs in the worker, so `embed` is the in-process engine call on a model the client loaded.
const run = createRagOps({
  AbortController,
  // The suite only sends ASCII.
  encode: (text) => Uint8Array.from(text, (c) => c.charCodeAt(0)),
  root: os.tmpdir(),
  join: (...parts) => path.join(...parts),
  async removeDir(dir) {
    await fs.promises.rm(dir, { recursive: true, force: true })
  },
  async listDir(dir) {
    try {
      return await fs.promises.readdir(dir)
    } catch (err) {
      if (err?.code === 'ENOENT') return []
      throw err
    }
  },
  async embed(modelId, text) {
    const { embedding } = await embed({ modelId, text })
    return embedding
  }
})

const handlers = Object.fromEntries(
  RAG_OPS.map((op) => [
    op,
    defineHandler({
      requestSchema: z.object({}).passthrough(),
      responseSchema: z.object({}).passthrough(),
      streaming: false,
      async handler(request) {
        return await run(op, request)
      }
    })
  ])
)

export default definePlugin({
  modelType: 'rag-e2e',
  displayName: 'RAG (e2e)',
  addonPackage: 'rag-e2e-plugin',
  skipPrimaryModelPathValidation: true,
  loadConfigSchema: z.object({}).passthrough(),
  createModel() {
    return { model: { async load() {}, unload() {} } }
  },
  handlers
})

#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'

import { artifactRoot, rankWorkerBinary, serverBinary } from '../index.js'

const binary = serverBinary()
if (!fs.existsSync(binary)) {
  console.error(`SGLang server is not staged at ${binary}. Run pnpm build in packages/sglang.`)
  process.exit(1)
}

const args = process.argv.slice(2)
if (!args.includes('--artifacts')) {
  args.push('--artifacts', artifactRoot())
}

const env = { ...process.env }
if (!env.SGL_CPP_RANK_WORKER) env.SGL_CPP_RANK_WORKER = rankWorkerBinary()

const child = spawn(binary, args, { stdio: 'inherit', env })
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

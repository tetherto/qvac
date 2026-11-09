// Opt-in: drives a real external CLI with the user's login; argv[2] is optional JSON options.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import { fileURLToPath } from 'bare-url'
import { compiledModule } from '../helpers/package-under-test.mjs'
const { bootCore } = await import(compiledModule('lib/runtime/core-host.js').href)
const options = JSON.parse(Bare.argv[2] || '{}')
const target = options.target || 'codex',
  model = options.model || 'Qwen3.5-2B-Q4_K_M'
if (!['codex', 'claude'].includes(target)) {
  throw new Error('target must be codex or claude')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-delegation-smoke-'))
const folder = path.join(root, 'fixture'),
  state = path.join(root, 'state')
fs.mkdirSync(folder)
fs.mkdirSync(state)
const marker = `QVAC_DELEGATION_${Date.now()}`
fs.writeFileSync(path.join(folder, 'ANSWER.txt'), marker + '\n')
const config = {
  core: {
    dataDir: state,
    model,
    autoDownloadModels: false,
    folders: [{ path: folder, write: false }]
  },
  harness: {
    policy: { network: { mode: 'on' } },
    plugins: [],
    delegation: {
      read: [target],
      slots: 1,
      maxExternal: 1,
      targets: [
        {
          name: target,
          description: `Read-only ${target} integration check`,
          protocol: target,
          command: options.command || target,
          login: 'user',
          maxTurns: 3,
          maxCostUsd: 0.2
        }
      ]
    }
  },
  tui: {}
}
const configFile = path.join(state, 'cli-runtime-config.json')
fs.writeFileSync(configFile, JSON.stringify({ config, configPath: null }), {
  mode: 0o600
})
process.env.QVAC_CLI_CONFIG = configFile
process.env.QVAC_HARNESS_HOST_MODULE = fileURLToPath(
  compiledModule('lib/runtime/harness-extension.js')
)
let host,
  runId,
  meshId,
  chatId,
  exitCode = 0
const until = async (fn, label, ms = 120000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) {
      return value
    }

    await new Promise((r) => setTimeout(r, 200))
  }

  throw new Error(`Timed out: ${label}`)
}
try {
  host = await bootCore({
    dataDir: state,
    model,
    noDefaultModels: true,
    config,
    deviceName: 'Delegation review'
  })
  const e = host.engine
  ;({ meshId } = await e.account({}))
  const { agents } = await e.listAgents({ meshId })
  const agent = agents.find((a) => a.isDefault && a.modelName === model)
  if (!agent) {
    throw new Error('Configured local agent not found')
  }

  const chat = await e.createChat({
    meshId,
    agentId: agent.id,
    config: { title: `Real ${target} delegation review` }
  })
  chatId = chat.id
  const request = await e.sendMessage({
    meshId,
    chatId,
    text: `Use the delegate tool now. Delegate exactly one task to target "${target}": "Read ANSWER.txt in the current directory and return its exact contents. Do not modify any files, use the network, or inspect other paths." Do not do the read yourself. After the delegate returns, repeat its answer.`
  })
  runId = request.runId
  console.log(JSON.stringify({ phase: 'requested', root, target, model, runId }))
  const seen = new Set()
  const chunks = await until(async () => {
    const { chunks } = await e.listChunks({ meshId, chatId })
    for (const c of chunks) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (
        c.type === 'tool-call' ||
        c.type === 'tool-result' ||
        c.type === 'approval-request' ||
        c.type === 'run-status'
      ) {
        console.log(
          JSON.stringify({
            phase: 'event',
            type: c.type,
            detail: c.toolCall || c.toolResult || c.approvalRequest || c.runStatus
          })
        )
      }
    }

    return (
      chunks.some(
        (c) =>
          c.type === 'run-status' &&
          ['completed', 'failed', 'canceled', 'cancelled', 'aborted'].includes(c.runStatus.state)
      ) && chunks
    )
  }, 'external delegate completion')
  fs.writeFileSync(path.join(root, 'chunks.json'), JSON.stringify(chunks, null, 2))
  const delegated = chunks.filter(
    (c) => c.type === 'tool-result' && c.toolResult?.name === 'delegate'
  )
  const resultText = JSON.stringify(delegated)
  if (!delegated.length) {
    throw new Error('No delegate tool-result: the model did not actually delegate')
  }

  if (!resultText.includes(marker) || !resultText.includes('answered')) {
    throw new Error('Delegate did not return the fixture marker successfully')
  }

  if (
    fs.readFileSync(path.join(folder, 'ANSWER.txt'), 'utf8') !== marker + '\n' ||
    fs.readdirSync(folder).length !== 1
  ) {
    throw new Error('Read-only fixture changed')
  }

  console.log(
    JSON.stringify({
      ok: true,
      target,
      root,
      checks: [
        'Core run',
        'delegate tool invocation',
        'actual external CLI result',
        'fixture read',
        'fixture unchanged'
      ]
    })
  )
} catch (error) {
  console.error(error.stack || error)
  if (host && runId) {
    await host.engine.stopRun({ meshId, chatId, runId }).catch(noop)
  }

  exitCode = 1
} finally {
  await host?.close()
  Bare.exit(exitCode)
}

function noop() {}

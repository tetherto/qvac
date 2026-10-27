// Opt-in integration test: real Client/Core, temporary state, explicit quack model.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { compiledModule } from '../helpers/package-under-test.mjs'
const { bootCore } = await import(compiledModule('lib/runtime/core-host.js').href)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-cli-smoke-'))
let host
const assert = (value, message) => {
  if (!value) throw new Error(message)
}
const until = async (fn, label) => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) {
      return v
    }

    await new Promise((r) => setTimeout(r, 100))
  }

  throw new Error(`Timed out: ${label}`)
}
let exitCode = 0
try {
  host = await bootCore({
    dataDir: root,
    fakeModels: true,
    noDefaultModels: true,
    deviceName: 'CLI integration'
  })
  let e = host.engine
  const { meshId } = await e.account({})
  const a = await until(async () => {
    const { agents } = await e.listAgents({ meshId })
    return agents.find((a) => a.modelName === 'quack')
  }, 'default agent')
  const workspace = await e.createWorkspace({
    config: { name: 'Integration workspace' }
  })
  assert(
    (await e.getWorkspace({ meshId: workspace.meshId })).name === 'Integration workspace',
    'workspace create'
  )
  const chat = await e.createChat({
    meshId,
    agentId: a.id,
    config: { title: 'Integration chat' }
  })
  const request = await e.sendMessage({
    meshId,
    chatId: chat.id,
    text: 'Hello from the product CLI'
  })
  const chunks = await until(async () => {
    const { chunks } = await e.listChunks({ meshId, chatId: chat.id })
    return chunks.some((c) => c.runStatus?.state === 'completed') && chunks
  }, 'completion')
  assert(
    chunks.some((c) => c.type === 'content' && c.content?.text.includes('quack')),
    'streamed content missing'
  )
  await e.setConfig({ ...(await e.getConfig({})), onboardingCompleted: true })
  await host.close()
  host = null
  host = await bootCore({
    dataDir: root,
    fakeModels: true,
    noDefaultModels: true
  })
  e = host.engine
  assert((await e.getConfig({})).onboardingCompleted, 'setup did not persist')
  assert(
    (await e.getWorkspace({ meshId: workspace.meshId })).name === 'Integration workspace',
    'workspace did not persist'
  )
  const restored = await e.listChunks({ meshId, chatId: chat.id })
  assert(
    restored.chunks.some((c) => c.type === 'content'),
    'conversation did not persist'
  )
  const next = await e.sendMessage({
    meshId,
    chatId: chat.id,
    text: 'Continue'
  })
  await e.stopRun({ meshId, chatId: chat.id, runId: next.runId })
  await until(async () => {
    const { chunks } = await e.listChunks({ meshId, chatId: chat.id })
    return chunks.some(
      (c) =>
        c.runId === next.runId &&
        ['completed', 'canceled', 'cancelled', 'aborted'].includes(c.runStatus?.state)
    )
  }, 'stop')
  const invitation = await e.meshInvite({
    member: true,
    meshId: workspace.meshId
  })
  const preview = await e.previewMeshInvite({ invite: invitation.invite })
  assert(preview.memberInvite, 'member invitation type')
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'Core boot',
        'workspace create',
        'streamed completion',
        'setup restart',
        'workspace restart',
        'chat persistence',
        'stop',
        'invitation preview'
      ],
      storage: root,
      runId: request.runId
    })
  )
} catch (error) {
  console.error(error.stack || error)
  exitCode = 1
} finally {
  await host?.close()
  Bare.exit(exitCode)
}

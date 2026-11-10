import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { enableSkills, installSkills, skillsOverlayDir } from '../../dist/lib/runtime/skills.js'
import { availableSkills, loadSkillCatalog } from '@qvac/harness/skill-catalog'
import { modelNameToCapabilityProfile } from '@qvac/harness/lib/models/model-catalog.ts'

const SHIPPED = fileURLToPath(new URL('../../skills', import.meta.url))

test('installSkills puts the shipped skills beside the SDK config', (t) => {
  const { home, sdkConfigPath } = sdkHome(t)

  const names = installSkills(fs, { from: SHIPPED, sdkConfigPath })

  assert.deepEqual(names, ['qvac-plugins'])
  assert.equal(skillsOverlayDir(sdkConfigPath), path.join(home, 'skills'))
  assert.equal(
    fs.readFileSync(path.join(home, 'skills', 'qvac-plugins', 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(SHIPPED, 'qvac-plugins', 'SKILL.md'), 'utf8')
  )
})

test('installSkills replaces what an older version left and keeps the user skills', (t) => {
  const { home, sdkConfigPath } = sdkHome(t)
  fs.mkdirSync(path.join(home, 'skills', 'qvac-plugins'), { recursive: true })
  fs.mkdirSync(path.join(home, 'skills', 'mine'))
  fs.writeFileSync(path.join(home, 'skills', 'qvac-plugins', 'SKILL.md'), 'old')
  fs.writeFileSync(path.join(home, 'skills', 'mine', 'SKILL.md'), 'mine')

  installSkills(fs, { from: SHIPPED, sdkConfigPath })

  const read = (name) => fs.readFileSync(path.join(home, 'skills', name, 'SKILL.md'), 'utf8')
  assert.notEqual(read('qvac-plugins'), 'old')
  assert.equal(read('mine'), 'mine')
})

test('qvac-plugins is offered to 9B models and larger only', async (t) => {
  const { sdkConfigPath } = sdkHome(t)
  installSkills(fs, { from: SHIPPED, sdkConfigPath })
  const overlay = skillsOverlayDir(sdkConfigPath)

  assert.deepEqual(await offeredTo('Qwen3.5-2B-Q4_K_M', overlay), [])
  assert.deepEqual(await offeredTo('Qwen3.5-4B-Q4_K_M', overlay), [])
  assert.deepEqual(await offeredTo('Qwen3.5-9B-Q4_K_M', overlay), ['qvac-plugins'])
  assert.deepEqual(await offeredTo('Qwen3.6-27B-UD-Q4_K_XL', overlay), ['qvac-plugins'])
})

test('enableSkills turns a new skill on beside the ones the agent has', async () => {
  const engine = recorder()
  const agent = { id: 'a1', enabledSkills: ['pdf'], installedSkills: ['pdf'] }

  await enableSkills(engine, { meshId: 'm1', agent, names: ['qvac-plugins'] })

  assert.deepEqual(engine.updates, [
    { agentId: 'a1', meshId: 'm1', config: { enabledSkills: ['pdf', 'qvac-plugins'] } }
  ])
})

test('enableSkills leaves a skill the user turned off alone', async () => {
  const engine = recorder()
  const agent = { id: 'a1', enabledSkills: [], installedSkills: ['qvac-plugins'] }

  await enableSkills(engine, { meshId: 'm1', agent, names: ['qvac-plugins'] })

  assert.deepEqual(engine.updates, [])
})

function sdkHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-skills-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  return { home, sdkConfigPath: path.join(home, 'qvac.config.json') }
}

async function offeredTo(model, overlayDir) {
  const catalog = await loadSkillCatalog(path.join(overlayDir, 'no-base'), {
    platform: 'darwin',
    overlayDir
  })

  return availableSkills(catalog, new Set(), modelNameToCapabilityProfile(model)).map((s) => s.name)
}

function recorder() {
  const updates = []
  return { updates, updateAgent: (request) => Promise.resolve(updates.push(request)) }
}

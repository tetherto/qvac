import assert from 'node:assert/strict'
import test from 'node:test'
import { mintInvites } from '../../dist/cli/commands/invite/invites.js'

const engine = (refusal) => ({
  meshInvite: async ({ member }) => {
    if (member && refusal) {
      throw Object.assign(new Error(refusal.message), { code: refusal.code })
    }

    return { invite: member ? 'qvac://member' : 'qvac://device' }
  },
  listMeshes: async () => ({ meshes: [{ meshId: 'w1', workspace: true, state: 'joined' }] }),
  getWorkspace: async () => ({ name: 'Team' }),
  listMembers: async () => ({ members: [] })
})

test('an admin gets a member invite as well as the device one', async () => {
  const invites = await mintInvites(engine())
  assert.equal(invites.member, 'qvac://member')
  assert.equal(invites.device, 'qvac://device')
})

test('a joiner has no member invite, also while its account has not recorded the workspace yet', async () => {
  for (const refusal of [
    { code: 100119, message: 'Only an admin can invite a member' },
    { code: 100205, message: 'An account mesh cannot be invited into' }
  ]) {
    const invites = await mintInvites(engine(refusal))
    assert.equal(invites.member, null, refusal.message)
    assert.equal(invites.device, 'qvac://device')
  }
})

test('your own workspace has no member invite', async () => {
  const invites = await mintInvites(
    engine({
      code: 100128,
      message: 'Your own workspace is yours alone: invite people into another workspace'
    })
  )
  assert.equal(invites.member, null)
  assert.equal(invites.device, 'qvac://device')
})

test('any other failure to mint still surfaces', async () => {
  await assert.rejects(mintInvites(engine({ code: 1, message: 'disk full' })), /disk full/)
})

test('a personal workspace listed first does not hide a shared workspace invite', async () => {
  const api = engine()
  api.listMeshes = async () => ({
    meshes: [
      { meshId: 'personal', workspace: true, state: 'joined' },
      { meshId: 'team', workspace: true, state: 'joined' }
    ]
  })
  api.meshInvite = async ({ member, meshId }) => {
    if (member && meshId === 'personal') {
      throw Object.assign(new Error('OWN_WORKSPACE_INVITE_REFUSED'), { code: 100128 })
    }
    return { invite: member ? 'qvac://team' : 'qvac://device' }
  }
  const invites = await mintInvites(api)
  assert.equal(invites.member, 'qvac://team')
  assert.equal(invites.workspace.meshId, 'team')
})

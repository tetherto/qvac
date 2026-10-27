import type { CommandIO } from './io.js'
type Mesh = NonNullable<Awaited<ReturnType<Capabilities['listMeshes']>>['meshes']>[number]
import type { Capabilities } from '@qvac/core/client'
import { CommandError } from './errors.js'

export async function describeInvite(engine: Capabilities, link: string) {
  let preview
  try {
    preview = await engine.previewMeshInvite({ invite: link })
  } catch {
    throw new CommandError('not a QV.AC invite: expected qvac://workspace/… or qvac://device/…', {
      code: 2
    })
  }

  const member = !!preview.memberInvite
  const who = member
    ? 'a member of a workspace, as a new person'
    : `one of ${preview.inviterName ? `${preview.inviterName}'s` : 'your own'} devices`

  return {
    member,
    inviterName: preview.inviterName ?? null,
    summary: `This link makes this device ${who}.`
  }
}

// A join lands once a peer holding the mesh is reachable; member skips a second preview.
export async function joinAndWait(
  engine: Capabilities,
  link: string,
  { io, member }: { io: Pick<CommandIO, 'note' | 'stopping'>; member?: boolean }
) {
  member ??= (await describeInvite(engine, link)).member
  const { meshes } = await engine.listMeshes({})
  const before = new Set((meshes ?? []).map((mesh) => mesh.meshId))
  const meshWatch = engine.meshesWatch({})
  const statusWatch = engine.meshStatusWatch({})
  try {
    const admitted = admittedMesh({ meshWatch, statusWatch, before, member })
    // a failure frame before the race is still the race's answer, not an unhandled rejection
    admitted.catch(noop)
    await engine.joinMesh({ invite: link })
    io.note('Joining… waiting for a device that holds it to be reachable (Ctrl+C cancels).')
    const outcome = await Promise.race([admitted, io.stopping.then(() => null)])
    if (outcome) {
      return outcome.mesh
    }

    await engine.cancelMeshJoin({})

    throw new CommandError('join cancelled.', { code: 130 })
  } finally {
    meshWatch.destroy()
    statusWatch.destroy()
  }
}

// The account's status settles first, so it answers only a device pairing, where no mesh appears.
function admittedMesh({
  meshWatch,
  statusWatch,
  before,
  member
}: {
  meshWatch: ReturnType<Capabilities['meshesWatch']>
  statusWatch: ReturnType<Capabilities['meshStatusWatch']>
  before: Set<string>
  member: boolean
}) {
  return new Promise<{ mesh: Mesh | null }>((resolve, reject) => {
    let joining = false
    meshWatch.on('data', ({ meshes }) => {
      const mesh = (meshes ?? []).find((m) => !before.has(m.meshId) && m.state === 'joined')
      if (mesh) {
        resolve({ mesh })
      }
    })
    statusWatch.on('data', ({ state, error }) => {
      if (state === 'error') {
        reject(new CommandError(`the join failed: ${error || 'no reason given'}`))
      }

      if (state === 'joining') {
        joining = true
      }

      if (state === 'joined' && joining && !member) {
        resolve({ mesh: null })
      }
    })
  })
}

function noop() {}

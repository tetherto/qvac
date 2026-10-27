type Invites = Awaited<ReturnType<typeof mintInvites>>
interface QRFlags {
  qr?: boolean
  color?: boolean | undefined
  columns?: number | undefined
}
import type { CommandIO } from '../../io.js'
import type { Capabilities } from '@qvac/core/client'
import type { RuntimeOptions } from '../../../lib/types.js'
import type { CoreHost } from '../../../lib/types.js'
import { qrLines } from '../../../product/qr.js'
import { joinedWorkspaces } from '../../snapshot.js'

// Only an admin has a member invite, and never for their own workspace; just after a join Core
// refuses it as an account mesh instead.
const NO_MEMBER_INVITE = [
  'WORKSPACE_ADMIN_ONLY',
  'MEMBER_INVITE_ACCOUNT_REFUSED',
  'OWN_WORKSPACE_INVITE_REFUSED',
  '100119',
  '100128',
  '100205'
]
const ANSI = /\x1b\[[0-9;]*m/g

export async function mintInvites(engine: Capabilities) {
  const [{ invite: device }, workspaces] = await Promise.all([
    engine.meshInvite({}),
    joinedWorkspaces(engine)
  ])
  // Personal workspaces cannot issue member invites and list order is not stable.
  let workspace = workspaces[0] ?? null
  let member: string | null = null
  for (const candidate of workspaces) {
    const invite = await memberInvite(engine, candidate.meshId)
    if (invite) {
      workspace = candidate
      member = invite
      break
    }
  }

  return {
    device: device ?? null,
    member,
    workspace: workspace && { meshId: workspace.meshId, name: workspace.name }
  }
}

function qrCode(invite: string, { color, columns }: QRFlags) {
  const rows = qrLines(invite, { color })
  const width = [...rows[0]!.replace(ANSI, '')].length
  if (!columns || width <= columns) {
    return rows
  }

  return [`(A QR code of the device invite needs ${width} columns; this terminal has ${columns}.)`]
}

async function memberInvite(engine: Capabilities, meshId: string) {
  try {
    return (await engine.meshInvite({ member: true, meshId })).invite ?? null
  } catch (caught) {
    const error = caught as Error & { code?: string }
    const said = [error.code, error.name, error.message].map(String)
    if (!NO_MEMBER_INVITE.some((code) => said.some((text) => text.includes(code)))) {
      throw error
    }

    return null
  }
}

export function inviteLines(
  { device, member, workspace }: Partial<Invites>,
  { qr, color, columns }: QRFlags
) {
  const lines = []
  if (device) {
    if (qr) {
      lines.push(...qrCode(device, { color, columns }), '')
    }

    lines.push(
      'Pair another of your devices with this one',
      '  On a new machine: qvac serve --device-join <link>, or paste it when QV.AC sets up',
      '  On your phone: Settings → My Devices → Pair New Device → Join With Code',
      `  ${device}`
    )
  }

  if (member) {
    lines.push('', `Invite people to ${workspace?.name || 'your workspace'}`, `  ${member}`)
  }

  return lines
}

// qvac invite: this device's link, for a device that pairs with it; a workspace link only with --json
export async function invite(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const invites = await mintInvites(host.engine)
  if (options.json) {
    io.json({ device: invites.device, member: invites.member, workspace: invites.workspace })
    return 0
  }

  io.lines(
    inviteLines(
      { device: invites.device },
      { qr: io.tty.stdout, color: io.color, columns: options.columns }
    )
  )

  return 0
}

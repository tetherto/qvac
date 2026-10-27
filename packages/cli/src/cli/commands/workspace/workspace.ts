import type { CommandIO } from '../../io.js'
import type { RuntimeOptions } from '../../../lib/types.js'
import type { CoreHost } from '../../../lib/types.js'
import { describeInvite, joinAndWait } from '../../join.js'
import { markSetUp } from '../serve/setup.js'
import { joinedWorkspaces, thisDevice, workspaceInfo } from '../../snapshot.js'

// What Core's logout does not do, so nobody expects it of `qvac workspace leave`.
const NOT_DONE = [
  'Your other devices keep everything, and through them you stay in each workspace.',
  'Nothing is deleted: what this device held is archived on it.',
  'Leaving a workspace as a person, with all your devices, is not done here: do it in the app.'
]

// A workspace is made after setup, by choice: setup only pairs devices or sets one up alone.
export async function create(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const { engine } = host
  const { meshId, name } = await engine.createWorkspace({})
  await markSetUp(engine, { done: true })
  if (options.json) {
    io.json({ status: 'created', meshId, name: name || null })
  } else {
    io.note(`Created ${name || 'a workspace'}. qvac invite --json prints its member link.`)
  }

  return 0
}

export async function join(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const { engine } = host
  const link = options.words[0]!
  const invite = await describeInvite(engine, link)
  io.note(invite.summary)
  if (!invite.member) {
    io.note('Whatever this device holds now is archived; your account moves to the inviter.')
  }

  if (!(await io.confirm('Join?', { yes: options.yes, unattended: true }))) {
    io.note('Not joined.')
    return 1
  }

  const mesh = await joinAndWait(engine, link, { io })
  await markSetUp(engine, { done: true })
  const name = mesh?.workspace ? (await workspaceInfo(engine, mesh)).name : null
  if (options.json) {
    io.json({ status: 'joined', meshId: mesh?.meshId ?? null, name, member: invite.member })
  } else {
    io.note(name ? `Joined ${name}.` : 'Joined.')
  }

  return 0
}

export async function leave(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const { engine } = host
  const [account, workspaces, self] = await Promise.all([
    engine.account({}),
    joinedWorkspaces(engine),
    thisDevice(host)
  ])
  const names = workspaces.map((w) => w.name)
  const leaves = names.length ? ` and leaves ${names.join(', ')}` : ''
  io.note(`This unpairs ${self} from your account${leaves}.`)
  for (const line of NOT_DONE) {
    io.note(`  ${line}`)
  }

  if (!(await io.confirm('Unpair this device?', { yes: options.yes }))) {
    io.note('Still paired.')
    return 1
  }

  await engine.leaveMesh({ meshId: account.meshId! })
  await markSetUp(engine, { done: false })
  if (options.json) {
    io.json({ status: 'left', workspaces: names })
  } else {
    io.note('Unpaired. qvac serve sets this device up again.')
  }

  return 0
}

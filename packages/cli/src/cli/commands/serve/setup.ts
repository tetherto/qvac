import type { CommandIO } from '../../io.js'
import type { Capabilities } from '@qvac/core/client'
import type { RuntimeOptions } from '../../../lib/types.js'
import type { CoreHost } from '../../../lib/types.js'
import process from '#process'
import { CommandError } from '../../errors.js'
import { describeInvite, joinAndWait } from '../../join.js'

export async function markSetUp(engine: Capabilities, { done }: { done: boolean }) {
  await engine.setConfig({ ...(await engine.getConfig({})), onboardingCompleted: done })
}

// First run only: a device that finished setup resumes on restart and asks nothing.
export async function setUp(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const { onboardingCompleted } = await host.engine.getConfig({})
  if (onboardingCompleted) {
    const ignored = (['create', 'join', 'deviceJoin'] as const).find((key) => options[key])
    if (ignored) {
      io.note(
        `This device is already set up, so --${flagName(ignored)} is ignored. qvac workspace join <link> adds a workspace.`
      )
    }

    if (options.deviceName) {
      await renameThisDevice(host, options.deviceName)
    }

    return { created: false }
  }

  const plan = await choosePlan(host, options, io)
  const created = plan.kind === 'create'
  if (plan.accountName) {
    await host.engine.updateMember({ config: { name: plan.accountName } })
  }

  // on its own unless a link pairs it; --create and --join are for scripts that want a workspace now
  if (created) {
    await host.engine.createWorkspace({})
  } else if ('link' in plan && plan.link) {
    await joinAndWait(host.engine, plan.link, { io })
  }

  await renameThisDevice(host, plan.deviceName)
  // a pairing or join moved this device into an account its boot never configured
  if ('link' in plan && plan.link) {
    await host.configure()
  }

  await markSetUp(host.engine, { done: true })

  return { created }
}

const flagName = (key: string) => (key === 'deviceJoin' ? 'device-join' : key)

async function choosePlan(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  const chosen = (['create', 'join', 'deviceJoin'] as const).filter((key) => options[key])
  if (chosen.length > 1) {
    throw new CommandError('pass one of --create, --join <link> or --device-join <link>.', {
      code: 2
    })
  }

  if (options.create && !options.accountName && !io.interactive) {
    throw new CommandError('missing --account-name <name> (or QVAC_ACCOUNT_NAME) for --create.', {
      code: 2
    })
  }

  const deviceName = options.deviceName || host.deviceName
  if (options.create) {
    const accountName = options.accountName || (await askAccountName(options, io))
    return { kind: 'create', accountName, deviceName }
  }

  if (options.join || options.deviceJoin) {
    const link = (options.join || options.deviceJoin)!
    const invite = await describeInvite(host.engine, link)
    checkKind(invite, options)
    return {
      kind: 'join',
      link,
      accountName: invite.member ? options.accountName : null,
      deviceName
    }
  }

  // with nothing to ask in, it sets up on its own; qvac workspace join <device link> pairs it later
  if (!io.interactive) {
    return { kind: 'alone', accountName: options.accountName || null, deviceName }
  }

  return askPlan(host, options, io)
}

function checkKind(invite: { member: boolean }, options: RuntimeOptions) {
  if (options.join && !invite.member) {
    throw new CommandError('that is a device invite: use --device-join.', { code: 2 })
  }

  if (options.deviceJoin && invite.member) {
    throw new CommandError('that is a workspace invite: use --join.', { code: 2 })
  }
}

// Setup pairs with a device you have, or sets up on its own; workspaces come after, by choice.
async function askPlan(host: CoreHost, options: RuntimeOptions, io: CommandIO) {
  io.line(`Welcome to QV.AC ${options.version}. Let's set up this device.`)
  io.line('To pair it with one you have, get a device link there: QV.AC → Devices → Pair a device.')
  const pasted = await io.ask('Paste the device link, or press enter to set it up on its own', {
    optional: true,
    yes: options.yes
  })
  const link = pasted.trim() || null
  const invite = link ? await describeInvite(host.engine, link) : null
  if (invite?.member) {
    throw new CommandError(
      'that is a workspace link. Set this device up first, then: qvac workspace join <link>.',
      { code: 2 }
    )
  }

  if (invite) {
    io.note(invite.summary)
  }

  const accountName = invite ? null : options.accountName || (await askAccountName(options, io))
  const deviceName =
    options.deviceName ||
    (await io.ask("This device's name", { fallback: host.deviceName, yes: options.yes }))

  return { kind: invite ? 'join' : 'alone', link, accountName, deviceName }
}

function askAccountName(options: RuntimeOptions, io: CommandIO) {
  return io.ask('Account name', { fallback: process.env['USER'], yes: options.yes })
}

async function renameThisDevice(host: CoreHost, name: string) {
  const { meshId } = await host.engine.account({})
  await host.engine.renameDevice({ meshId: meshId!, config: { name } })
  host.deviceName = name
}

import type { ProductApp } from '../app.js'
import type { KeyMessage, Command } from '../app-types.js'
import { plain } from '../theme.js'
import { joinAndWait } from '../../cli/join.js'
import { FORMS } from './pages.js'

const DEFAULT_MODEL = 'Qwen3.5-2B-Q4_K_M'

// setup pages take every key; the join preview takes enter
export const MODAL = new Map<string, (app: ProductApp, msg: KeyMessage) => Command>([
  ...FORMS.map((page): [string, typeof formKey] => [page, formKey]),
  ['welcome', welcomeKey],
  ['download', downloadKey],
  ['invite', inviteKey]
])

export const ENTER = new Map([['join-confirm', nameJoiner]])

const FORM_SUBMITS: Record<string, (app: ProductApp, value: string) => Command> = {
  name: submitName,
  'device-name': submitDeviceName,
  join: submitJoin
}

function welcomeKey(app: ProductApp, msg: KeyMessage) {
  if (msg.is('up', 'down')) {
    app.choice = 1 - app.choice
  }

  if (msg.is('enter')) {
    const joining = app.choice === 0
    app.page = joining ? 'join' : 'name'
    app.form = joining ? '' : app.setupNames.account
    app.joinValue = ''
  }

  return null
}

function nameJoiner(app: ProductApp) {
  app.page = 'device-name'
  app.form = app.setupNames.device

  return null
}

// Waits as qvac serve --device-join does: a pairing adds no mesh, so the account's status says.
function pair(app: ProductApp, deviceName: string) {
  const stopping = new Promise<void>((resolve) => {
    app.cancelJoin = resolve
  })
  app.page = 'joining'
  app.form = ''
  app.error = ''
  const io = { note() {}, stopping }

  return app.effect(async () => {
    await joinAndWait(app.engine!, app.joinValue, { io, member: false })
    // the device row to name, and the agent to set up, are in the account it just joined
    const { meshId } = await app.engine!.account({})
    await app.engine!.renameDevice({ meshId: meshId!, config: { name: deviceName } })
    await app.configureDevice()
  }, 'product.paired')
}

function downloadKey(app: ProductApp, msg: KeyMessage) {
  if (msg.is('enter')) {
    return app.showInvite()
  }

  if (msg.is('d')) {
    const name = app.agent?.modelName || DEFAULT_MODEL
    return app.action(() => app.engine!.retryModelDownload({ name }))
  }

  return null
}

function inviteKey(app: ProductApp, msg: KeyMessage) {
  if (msg.is('q')) {
    app.showQr = !app.showQr
  } else if (msg.is('enter')) {
    return app.finishOnboarding()
  } else if (msg.is('m')) {
    return app.showInvite({ member: true })
  } else if (msg.is('d')) {
    return app.showInvite()
  } else if (msg.is('ctrl+y') && app.invitation?.invite && app.options.copyToClipboard) {
    return app.action(() => app.options.copyToClipboard!(app.invitation!.invite!))
  }

  return null
}

function formKey(app: ProductApp, msg: KeyMessage) {
  if (msg.is('ctrl+u')) {
    app.form = ''
  } else if (msg.is('backspace')) {
    app.form = [...app.form].slice(0, -1).join('')
  } else if (msg.is('enter')) {
    return submitForm(app)
  } else if (!msg.ctrl && !msg.meta && msg.sequence >= ' ') {
    app.form += plain(msg.sequence)
  }

  return null
}

function submitForm(app: ProductApp) {
  const value = app.form.trim()
  if (!value) {
    app.error = 'Enter a value to continue.'
    return null
  }

  return FORM_SUBMITS[app.page]?.(app, value) ?? null
}

function submitName(app: ProductApp, value: string) {
  app.accountName = value
  app.form = app.setupNames.device
  app.page = 'device-name'
  return null
}

function submitDeviceName(app: ProductApp, value: string) {
  if (app.joinValue) {
    return pair(app, value)
  }

  return app.action(async () => {
    await app.engine!.updateMember({ config: { name: app.accountName } })
    await app.engine!.renameDevice({
      meshId: app.product!.account.meshId!,
      config: { name: value }
    })

    // onboarding sets up the device only; workspaces are made or joined from the overview after
    return null
  }, 'product.created')
}

function submitJoin(app: ProductApp, value: string) {
  app.joinValue = value
  return app.action(() => app.engine!.previewMeshInvite({ invite: value }), 'product.join-preview')
}

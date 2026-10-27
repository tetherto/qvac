import type { RpcResult } from './app-types.js'
type Model = NonNullable<RpcResult<'listModels'>['models']>[number]
import type { ProductApp } from './app.js'
import type { KeyMessage, Command } from './app-types.js'
import { plain } from './theme.js'
import { joinAndWait } from '../cli/join.js'
import { FORMS } from './dashboard-view.js'

const TAB_ORDER = ['overview', 'device', 'models']
const TAB_KEYS: Record<string, string> = { 1: 'overview', 2: 'device', 3: 'models' }
const LIST_PAGES = ['models', 'catalog', 'workspaces']
const DEFAULT_MODEL = 'Qwen3.5-2B-Q4_K_M'

const MODAL_KEYS = new Map<string, (app: ProductApp, msg: KeyMessage) => Command>([
  ...FORMS.map((page): [string, typeof formKey] => [page, formKey]),
  ['welcome', welcomeKey],
  ['download', downloadKey],
  ['invite', inviteKey],
  ['remove', removeKey]
])

const ENTER_KEYS = new Map([['join-confirm', nameJoiner]])

const SHORTCUTS: [string, (app: ProductApp) => Command][] = [
  ['q', (app: ProductApp) => app.tui.quit],
  ['i', (app: ProductApp) => app.showInvite()],
  ['v', (app: ProductApp) => app.showPage('devices')],
  ['w', (app: ProductApp) => app.assign({ page: 'workspaces', selection: 0 })],
  ['s', (app: ProductApp) => app.showPage('status')]
]

const FORM_SUBMITS: Record<string, (app: ProductApp, value: string) => Command> = {
  name: submitName,
  'device-name': submitDeviceName,
  join: submitJoin
}

export function dashboardKey(app: ProductApp, msg: KeyMessage) {
  if (app.actionBusy) {
    return null
  }

  if (msg.name === 'escape') {
    return back(app)
  }

  const modal = MODAL_KEYS.get(app.page)
  if (modal) {
    return modal(app, msg)
  }

  const enter = ENTER_KEYS.get(app.page)
  if (enter && msg.is('enter')) {
    return enter(app)
  }

  return navigationKey(app, msg)
}

function back(app: ProductApp) {
  if (app.page === 'welcome') return null
  if (app.page === 'joining') {
    app.cancelJoin()
    app.page = 'device-name'
    app.form = app.setupNames.device

    return null
  }

  app.page = backPage(app.page)
  app.form = ''
  app.error = ''

  return null
}

function backPage(page: string) {
  if (FORMS.includes(page)) return 'welcome'
  return ['overview', 'welcome'].includes(page) ? page : 'overview'
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

function removeKey(app: ProductApp, msg: KeyMessage) {
  if (msg.is('y')) {
    return app.action(async () => {
      const model = app.product!.models.find((m) => m.name === app.removeName)
      if (model?.isLoaded || model?.isLoading) {
        throw new Error('Unload this model before removing its weights.')
      }

      await app.engine!.deleteModel({ name: app.removeName })
      app.page = 'models'
    })
  }

  if (msg.is('n')) {
    app.page = 'models'
  }

  return null
}

function navigationKey(app: ProductApp, msg: KeyMessage) {
  if (msg.is('enter') && !LIST_PAGES.includes(app.page)) {
    return app.showPage('chat')
  }

  if (msg.sequence === '/' || msg.is('c')) {
    app.page = 'chat'
    if (msg.sequence === '/') {
      app.editor.set('/')
    }

    return null
  }

  const tab = TAB_KEYS[msg.sequence]
  if (tab && !msg.ctrl && !msg.meta) {
    return app.assign({ page: tab, selection: 0, error: '' })
  }

  if (msg.is('tab')) {
    return app.showPage(TAB_ORDER[(TAB_ORDER.indexOf(app.page) + 1) % TAB_ORDER.length]!)
  }

  const shortcut = SHORTCUTS.find(([key]) => msg.is(key))
  if (shortcut) {
    return shortcut[1](app)
  }

  if (msg.sequence === '?') {
    return app.showPage('help')
  }

  return pageKey(app, msg)
}

function pageKey(app: ProductApp, msg: KeyMessage) {
  // the lists come with the first snapshot; until then the page shows that Core is starting
  if (!app.product) {
    return null
  }

  if (app.page === 'workspaces') {
    return workspacesKey(app, msg)
  }

  if (app.page === 'models' || app.page === 'catalog') {
    return modelsKey(app, msg)
  }

  return null
}

function workspacesKey(app: ProductApp, msg: KeyMessage) {
  const workspaces = app.product!.meshes.filter((m) => m.workspace)
  if (msg.is('up', 'down')) {
    const step = msg.is('up') ? -1 : 1
    app.selection = (app.selection + step + workspaces.length) % Math.max(1, workspaces.length)
  }

  if (msg.is('enter') && workspaces[app.selection]) {
    app.workspaceId = workspaces[app.selection]!.meshId
    app.page = 'overview'
    return app.refresh()
  }

  return null
}

function modelsKey(app: ProductApp, msg: KeyMessage) {
  const models = (app.page === 'catalog' ? app.catalog : app.product!.models) ?? []
  if (msg.is('up', 'down')) {
    const step = msg.is('up') ? -1 : 1
    app.selection = models.length ? (app.selection + step + models.length) % models.length : 0
  }

  const model = models[app.selection]
  if (msg.is('a')) {
    return app.action(() => app.engine!.listModels({ type: 'llm' }), 'product.catalog')
  }

  return model ? modelKey(app, { msg, model }) : null
}

function modelKey(app: ProductApp, { msg, model }: { msg: KeyMessage; model: Model }) {
  const { name } = model
  if (msg.is('enter')) {
    return chooseModel(app, model)
  }

  if (msg.is('l')) {
    return toggleLoad(app, model)
  }

  if (msg.is('d')) {
    return app.action(() => app.engine!.retryModelDownload({ name }))
  }

  if (msg.is('x')) {
    return app.action(async () => {
      app.removeName = name
      app.removeUsers = (await app.engine!.modelUsers({ name })).agents || []
      app.page = 'remove'
    })
  }

  if (msg.is('p')) {
    return app.action(() => app.engine!.setModelPaused({ name, paused: true }))
  }

  return null
}

function chooseModel(app: ProductApp, model: Model) {
  if (app.page === 'catalog' && !model.isCached) {
    return app.action(() => app.engine!.retryModelDownload({ name: model.name }))
  }

  if (!['llm', 'completion'].includes(model.taskType || model.type || '')) {
    app.error = 'This is not a chat model. Use its voice, image or other tool in chat.'
    return null
  }

  app.page = 'chat'

  return app.useModel(model.name)
}

function toggleLoad(app: ProductApp, model: Model) {
  const { name, isLoaded } = model

  return app.action(async () => {
    const result = await (isLoaded
      ? app.engine!.unloadModel({ name })
      : app.engine!.loadModel({ name }))
    if (
      isLoaded ? !('unloaded' in result && result.unloaded) : !('loaded' in result && result.loaded)
    ) {
      throw new Error(loadError(model, 'reason' in result ? result : {}))
    }
  })
}

function loadError(model: Model, result: { reason?: string | null }) {
  if (model.isLoaded) {
    return 'This model is still in use. Try again when the run finishes.'
  }

  if (result.reason === 'memory') {
    return 'Not enough model memory. Unload another model first.'
  }

  return `Unable to load: ${result.reason || 'see diagnostics'}`
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

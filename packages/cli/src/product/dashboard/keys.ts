type Model = NonNullable<RpcResult<'listModels'>['models']>[number]
import type { RpcResult, KeyMessage, Command } from '@qvac/cli-kit/tui'
import type { ProductApp } from '../app.js'
import { FORMS } from '../onboarding/pages.js'

export type KeyHandler = (app: ProductApp, msg: KeyMessage) => Command
// What a product's dashboard answers: modal pages take every key, enter pages one, list pages the
// keys left after navigation, and shortcuts open pages from anywhere.
export interface DashboardKeys {
  modal: Map<string, KeyHandler>
  enter: Map<string, (app: ProductApp) => Command>
  shortcuts: [string, (app: ProductApp) => Command][]
  pages: Map<string, KeyHandler>
}

const TAB_ORDER = ['overview', 'device', 'models']
const TAB_KEYS: Record<string, string> = { 1: 'overview', 2: 'device', 3: 'models' }

export const SHORTCUTS: [string, (app: ProductApp) => Command][] = [
  ['q', (app: ProductApp) => app.tui.quit],
  ['i', (app: ProductApp) => app.showInvite()]
]

// the pages both products list: models on this device and the catalog
export const PAGES = new Map<string, KeyHandler>([
  ['models', modelsKey],
  ['catalog', modelsKey],
  ['remove', removeKey]
])

export function dashboardKey(app: ProductApp, msg: KeyMessage, keys: DashboardKeys) {
  if (app.actionBusy) {
    return null
  }

  if (msg.name === 'escape') {
    return back(app)
  }

  const modal = keys.modal.get(app.page)
  if (modal) {
    return modal(app, msg)
  }

  const enter = keys.enter.get(app.page)
  if (enter && msg.is('enter')) {
    return enter(app)
  }

  return navigationKey(app, msg, keys)
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

function navigationKey(app: ProductApp, msg: KeyMessage, keys: DashboardKeys) {
  if (msg.is('enter') && !keys.pages.has(app.page)) {
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

  const shortcut = keys.shortcuts.find(([key]) => msg.is(key))
  if (shortcut) {
    return shortcut[1](app)
  }

  if (msg.sequence === '?') {
    return app.showPage('help')
  }

  // the lists come with the first snapshot; until then the page shows that Core is starting
  if (!app.product) {
    return null
  }

  const page = keys.pages.get(app.page)

  return page ? page(app, msg) : null
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

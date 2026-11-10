import type { Command, RpcResult } from '../app-types.js'
import type { Dashboard } from './app.js'
type Value<T> = { value: T }

export const RECEIVERS = new Map<string, (app: Dashboard, msg: never) => Command>([
  ['product.join-preview', joinPreviewed],
  ['product.created', workspaceCreated],
  ['product.invite', invited],
  ['product.catalog', catalogLoaded],
  ['product.finished', onboarded],
  ['product.paired', paired]
])

function joinPreviewed(app: Dashboard, msg: Value<RpcResult<'previewMeshInvite'>>): Command {
  app.actionBusy = false
  // setup pairs devices; a workspace is joined after it, from the overview
  if (msg.value?.memberInvite && app.inSetup()) {
    app.error =
      'That is a workspace link. Pair with one of your devices here, and join workspaces after setup.'
    app.page = 'join'

    return null
  }

  app.joinPreview = msg.value
  app.page = 'join-confirm'

  return null
}

function workspaceCreated(
  app: Dashboard,
  msg: Value<RpcResult<'createWorkspace'> | null>
): Command {
  app.actionBusy = false
  app.product!.workspace = (msg.value || null) as NonNullable<typeof app.product>['workspace']
  app.page = 'download'
  return app.refresh()
}

function invited(app: Dashboard, msg: Value<RpcResult<'meshInvite'>>): Command {
  app.actionBusy = false
  app.invitation = msg.value
  app.page = 'invite'
  return null
}

function catalogLoaded(app: Dashboard, msg: Value<RpcResult<'listModels'>>): Command {
  app.actionBusy = false
  app.catalog = msg.value.models || []
  app.selection = 0
  app.page = 'catalog'
  return null
}

// an Esc that cancelled the join already left the page
function paired(app: Dashboard) {
  return app.page === 'joining' ? app.finishOnboarding() : null
}

function onboarded(app: Dashboard) {
  app.actionBusy = false
  app.page = app.chat ? 'chat' : 'overview'
  return app.refresh()
}

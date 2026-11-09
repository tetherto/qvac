import type { KeyMessage, Command } from '@qvac/cli-kit/tui'
import type { ProductApp } from '../app.js'

// the host's pages, from anywhere on the dashboard
export const SHORTCUTS: [string, (app: ProductApp) => Command][] = [
  ['v', (app: ProductApp) => app.showPage('devices')],
  ['w', (app: ProductApp) => app.assign({ page: 'workspaces', selection: 0 })],
  ['s', (app: ProductApp) => app.showPage('status')]
]

export const PAGES = new Map<string, (app: ProductApp, msg: KeyMessage) => Command>([
  ['workspaces', workspacesKey]
])

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

type Snapshot = Awaited<ReturnType<typeof snapshot>>
import type { snapshot } from '../data.js'
import type { Frame } from '../app-types.js'
import type { Dashboard } from '../dashboard/app.js'
import type { Page, PageView } from '../dashboard/frame.js'
import { hex } from '../data.js'
import { wrap } from '../../lib/terminal/text.js'
import { paint, count } from '../theme.js'
import { strong } from '../ink.js'

// The host's own pages: every device, the workspaces it serves, and its status.
export const PAGES: Record<string, PageView> = {
  devices: devicesPage,
  workspaces: workspacesPage,
  status: statusPage
}

function devicesPage(app: Dashboard, f: Frame): Page {
  const p = app.product!
  const devices = p.workspaceDevices || p.devices || []

  return {
    body: [
      strong('Together, more capable.'),
      '',
      ...devices.flatMap((d) => [
        f.two(paint(d.name, 'teal'), pairing(app, d)),
        paint(
          `${d.platform || 'Platform unavailable'} · ${count((d.cachedModelNames || []).length, 'model')} on disk`,
          'muted'
        ),
        ''
      ])
    ]
  }
}

function pairing(app: Dashboard, device: NonNullable<Snapshot['devices']>[number]) {
  if (hex(device.id) === hex(app.originDeviceId)) return 'This device'
  return device.revoked ? 'Removed' : 'Paired'
}

function workspacesPage(app: Dashboard): Page {
  const workspaces = app.product!.meshes.filter((m) => m.workspace)

  return {
    body: [
      strong('Choose your workspace.'),
      '',
      ...workspaces.map((m, i) =>
        paint(
          `${i === app.selection ? '›' : ' '} ${m.name || hex(m.meshId).slice(0, 12)} · ${m.state}`,
          i === app.selection ? 'teal' : 'text'
        )
      )
    ],
    hints: [
      ['↑↓', 'choose'],
      ['enter', 'open'],
      ['esc', 'back']
    ]
  }
}

function statusPage(app: Dashboard, f: Frame): Page {
  const status = {
    connection: app.meshStatus,
    stateDirectory: app.options.dataDir,
    memory: app.product!.memory
  }

  return {
    body: [strong('This device, right now.'), '', ...wrap(JSON.stringify(status, null, 2), f.inner)]
  }
}

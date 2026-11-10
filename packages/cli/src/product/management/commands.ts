import type { Command } from '../app-types.js'
import type { Dashboard } from '../dashboard/app.js'

// The palette's commands: every page and action the keys reach, by name.
export interface ProductCommand {
  name: string
  desc: string
  run: (app: Dashboard) => Command
}

export const COMMANDS: ProductCommand[] = [
  { name: 'overview', desc: 'Workspace dashboard', run: (app) => app.showPage('overview') },
  {
    name: 'device',
    desc: 'This device: hardware and loaded models',
    run: (app) => app.showPage('device')
  },
  {
    name: 'models',
    desc: 'Models to download, load and remove',
    run: (app) => app.assign({ page: 'models', selection: 0 })
  },
  { name: 'devices', desc: 'All your devices', run: (app) => app.showPage('devices') },
  {
    name: 'workspaces',
    desc: 'Choose your workspace',
    run: (app) => app.assign({ page: 'workspaces', selection: 0 })
  },
  {
    name: 'status',
    desc: 'Peers, models loaded and where state lives',
    run: (app) => app.showPage('status')
  },
  { name: 'invite', desc: 'Pair a device or invite a member', run: (app) => app.showInvite() },
  { name: 'help', desc: 'Keys and commands', run: (app) => app.showPage('help') },
  { name: 'quit', desc: 'Exit QV.AC', run: (app) => app.tui.quit }
]

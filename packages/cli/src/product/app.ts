import type { Command, Frame, KeyMessage, PageView, ProductOptions, Tui } from '@qvac/cli-kit/tui'
import {
  Dashboard,
  pageKey,
  renderDashboard,
  dashboardKey,
  DASHBOARD_PAGES,
  DASHBOARD_KEYS,
  DASHBOARD_SHORTCUTS,
  ONBOARDING_PAGES,
  ONBOARDING_MODAL,
  ONBOARDING_ENTER
} from '@qvac/cli-kit/tui'
import { paint } from '@qvac/cli-kit/brand'
import { PAGES as MANAGEMENT_PAGES } from './management/pages.js'
import { PAGES as MANAGEMENT_KEYS, SHORTCUTS as MANAGEMENT_SHORTCUTS } from './management/keys.js'
import { COMMANDS } from './management/commands.js'

// qvac's dashboard: setup, the shared pages, and the host's own
const PAGES = { ...ONBOARDING_PAGES, ...DASHBOARD_PAGES, ...MANAGEMENT_PAGES }
// the palette draws over the page it was opened on
const PALETTE: PageView = (app, f) => ({ body: (room) => app.pickerLines(f.inner, room) })
const KEYS = {
  modal: ONBOARDING_MODAL,
  enter: ONBOARDING_ENTER,
  shortcuts: [...DASHBOARD_SHORTCUTS, ...MANAGEMENT_SHORTCUTS],
  pages: new Map([...DASHBOARD_KEYS, ...MANAGEMENT_KEYS])
}

export function productApp(tui: Tui) {
  return class extends ProductApp {
    constructor(options?: ProductOptions) {
      super(tui, options)
    }
  }
}

// The management TUI: this device, its models and the workspaces it hosts, with setup.
export class ProductApp extends Dashboard {
  override routeKey(msg: KeyMessage): Command {
    if (this.picker) {
      return this.pickerKey(msg)
    }

    const jump = pageKey(msg, { plain: false })
    if (jump) {
      return this.showPage(jump)
    }

    // setup keeps the slash: its forms take it as text
    if (msg.sequence === '/' && !this.inSetup()) {
      return this.openPalette()
    }

    return dashboardKey(this, msg, KEYS)
  }

  // every command by name, from any page: what the chat's / offered the dashboard
  openPalette(): Command {
    return this.choose('Commands', {
      items: COMMANDS.map((c) => ({ label: `/${c.name}`, hint: c.desc, value: c })),
      onPick: (c) => c.run(this)
    })
  }

  override pageView(f: Frame) {
    return renderDashboard(this, f, this.picker ? { [this.page]: PALETTE } : PAGES)
  }

  override navHints(): [string, string][] {
    return [
      ['/', 'commands'],
      ['i', 'invite'],
      ['v', 'all devices'],
      ['w', 'workspace'],
      ['s', 'status'],
      ['q', 'quit']
    ]
  }

  override helpLines() {
    const key = (k: string, d: string) => paint(k.padEnd(14), 'teal') + d
    return [
      paint('Dashboard', 'muted'),
      key('1 2 3', 'overview · device · models'),
      key('tab', 'the next page'),
      key('i  v  w  s', 'invite · devices · workspaces · status'),
      key('esc', 'back to the overview'),
      key('/', 'every command by name'),
      key('?', 'this help'),
      key('q', 'quit'),
      '',
      paint('Models', 'muted'),
      key('↑↓', 'choose'),
      key('a', 'add a model from the catalog'),
      key('l', 'load or unload'),
      key('x', 'remove'),
      key('d', 'retry a download')
    ]
  }
}

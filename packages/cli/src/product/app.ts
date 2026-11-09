import type { Command, Frame, KeyMessage, ProductOptions, Tui } from '@qvac/cli-kit/tui'
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

// qvac's dashboard: setup, the shared pages, and the host's own
const PAGES = { ...ONBOARDING_PAGES, ...DASHBOARD_PAGES, ...MANAGEMENT_PAGES }
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
    const jump = pageKey(msg, { plain: false })
    if (jump) {
      return this.showPage(jump)
    }

    return dashboardKey(this, msg, KEYS)
  }

  override pageView(f: Frame) {
    return renderDashboard(this, f, PAGES)
  }

  override navHints(): [string, string][] {
    return [
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

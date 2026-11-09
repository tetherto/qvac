import type { Command, Frame, KeyMessage, Tui } from '@qvac/cli-kit/tui'
import {
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
import { ChatApp, type ChatOptions } from '../chat/app.js'

// duck's dashboard: setup and the shared pages
const PAGES = { ...ONBOARDING_PAGES, ...DASHBOARD_PAGES }
const KEYS = {
  modal: ONBOARDING_MODAL,
  enter: ONBOARDING_ENTER,
  shortcuts: DASHBOARD_SHORTCUTS,
  pages: DASHBOARD_KEYS
}

export function productApp(tui: Tui) {
  return class extends ProductApp {
    constructor(options?: ChatOptions) {
      super(tui, options)
    }
  }
}

// The dashboard pages beside the chat: overview, device, models, setup and invitations.
export class ProductApp extends ChatApp {
  backToChat(): Command {
    this.page = 'chat'
    this.error = ''
    this.form = ''
    this.composing = true
    return null
  }

  override routeKey(msg: KeyMessage): Command {
    if (msg.is('ctrl+g')) {
      this.page = this.page === 'chat' ? 'overview' : 'chat'
      this.error = ''
      return null
    }

    if (this.page === 'chat') {
      return super.routeKey(msg)
    }

    if (msg.name === 'escape' && !this.inSetup()) {
      return this.backToChat()
    }

    const jump = pageKey(msg, { plain: false })
    if (jump) {
      return this.showPage(jump)
    }

    return dashboardKey(this, msg, KEYS)
  }

  override pageView(f: Frame) {
    if (this.page === 'chat') {
      return super.pageView(f)
    }

    return renderDashboard(this, f, PAGES)
  }
}

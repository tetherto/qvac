// The TUI shell on bare-tui: the Shell class and its message types, the screen framework,
// selection, model labels, text measuring, the device snapshot and download rates.
export * from './product/shell.js'
export * from './product/app-types.js'
export * from './product/screen.js'
export * from './product/select.js'
export * from './product/model-label.js'
export * from './product/data.js'
export * from './product/download-rate.js'
export * from './product/qr.js'
export * from './product/session.js'
export * from './lib/terminal/text.js'
export { Editor } from './lib/terminal/editor.js'
// The dashboard: its state, frame and key routing, setup, the pages both products have.
export * from './product/dashboard/app.js'
export * from './product/dashboard/frame.js'
export {
  PAGES as DASHBOARD_KEYS,
  SHORTCUTS as DASHBOARD_SHORTCUTS,
  dashboardKey,
  type DashboardKeys,
  type KeyHandler
} from './product/dashboard/keys.js'
export { PAGES as DASHBOARD_PAGES, percentOf } from './product/dashboard/pages.js'
export { PAGES as ONBOARDING_PAGES, FORMS, SETUP_PAGES } from './product/onboarding/pages.js'
export { MODAL as ONBOARDING_MODAL, ENTER as ONBOARDING_ENTER } from './product/onboarding/keys.js'

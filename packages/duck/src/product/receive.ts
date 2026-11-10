import type { Shell } from './shell.js'
import type { Command, Connection, WatchFrame } from './app-types.js'
import type { snapshot } from './data.js'
type Value<T> = { value: T }
type Failure = { error: Error }

// The messages every product answers: Core connecting, the device's status and snapshot, actions.
export const RECEIVERS = new Map<string, (app: Shell, msg: never) => Command>([
  ['connected', (app, msg: Connection) => app.connected(msg)],
  ['boot-error', bootFailed],
  ['spin', spun],
  ['mesh-status', meshStatusChanged],
  ['downloads', downloadsChanged],
  ['error', failed],
  ['product.snapshot', snapshotArrived],
  ['product.poll', polled],
  ['product.snapshot-error', snapshotFailed],
  ['product.error', actionFailed],
  ['product.done', actionDone]
])

function bootFailed(app: Shell, msg: Failure): Command {
  app.status = `Could not start: ${msg.error.message}`
  app.error = app.status
  return null
}

function spun(app: Shell) {
  app.frame++
  app.spinning = false
  return app.spin()
}

function meshStatusChanged(app: Shell, msg: Value<WatchFrame<'meshStatusWatch'>>): Command {
  app.meshStatus = msg.value
  return app.watch('mesh-status')
}

function downloadsChanged(app: Shell, msg: Value<WatchFrame<'modelDownloadsWatch'>>): Command {
  app.modelDownloads = new Map((msg.value.downloads || []).map((d) => [d.name, d]))
  return app.watch('downloads')
}

function failed(app: Shell, msg: Failure): Command {
  app.notice = msg.error?.message || String(msg.error)
  return null
}

function snapshotArrived(app: Shell, msg: Value<Awaited<ReturnType<typeof snapshot>>>): Command {
  app.product = msg.value
  app.hostStatus = app.options.readHostStatus?.() || null

  return app.snapshotTaken()
}

function polled(app: Shell) {
  return app.tui.batch(
    app.refresh(),
    app.tui.tick(2500, () => ({ type: 'product.poll' }))
  )
}

function snapshotFailed(app: Shell, msg: Failure): Command {
  if (app.restarting) {
    return null
  }

  app.error = msg.error.message

  return null
}

function actionFailed(app: Shell, msg: Failure): Command {
  app.actionBusy = false
  if (app.page === 'chat') {
    app.notice = msg.error.message
  } else {
    app.error = msg.error.message
  }

  return null
}

function actionDone(app: Shell) {
  app.actionBusy = false
  return app.refresh()
}

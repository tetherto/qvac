import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, press, screen, settle, type } from './helpers/app.mjs'

// bare-tui-updater needs Bare's addons, so the app gets a banner with the same surface
function fakeBanner() {
  const banner = {
    width: 0,
    state: 'idle',
    version: '',
    spinner: { id: 'update-spinner' },
    accepted: 0,
    update(msg) {
      if (msg.type === 'update.ready') {
        banner.state = 'ready'
        banner.version = msg.version
      } else if (msg.type === 'update.dismiss') {
        banner.state = 'idle'
      } else if (msg.type === 'key' && msg.is('ctrl+u')) {
        banner.state = 'applying'
        banner.accepted++
        return [banner, () => Promise.resolve({ type: 'update.applied' })]
      } else if (msg.type === 'update.applied') {
        banner.state = 'applied'
      }

      return [banner, null]
    },
    view() {
      if (banner.state === 'ready') return `Update v${banner.version} ready\npress ctrl+u to update`
      if (banner.state === 'applied') return 'Update installed, restart to use it'
      return ''
    }
  }

  return banner
}

test('update banner: absent without an updater', async () => {
  const { app } = await boot()
  assert.equal(app.updateBanner, null)
  assert.doesNotMatch(screen(app), /Update v/)
})

test('update banner: a staged update shows above the composer without growing the frame', async () => {
  const { app } = await boot({ updateBanner: fakeBanner() })
  const rows = app.view().split('\n').length

  app.update({ type: 'update.ready', version: '9.9.9' })

  assert.match(screen(app), /Update v9\.9\.9 ready/)
  assert.match(screen(app), /press ctrl\+u to update/)
  assert.equal(app.view().split('\n').length, rows)
})

test('update banner: ctrl+u installs, plain u stays with the composer', async () => {
  const banner = fakeBanner()
  const { app } = await boot({ updateBanner: banner })
  app.update({ type: 'update.ready', version: '9.9.9' })

  type(app, 'u')
  assert.equal(banner.state, 'ready')
  assert.equal(app.editor.value, 'u')

  await settle(app, press(app, 'u', { ctrl: true }))

  assert.equal(banner.accepted, 1)
  assert.equal(banner.state, 'applied')
  assert.match(screen(app), /restart to use it/)
})

test('update banner: ctrl+u is the readline kill while nothing is staged', async () => {
  const banner = fakeBanner()
  const { app } = await boot({ updateBanner: banner })

  press(app, 'u', { ctrl: true })

  assert.equal(banner.accepted, 0)
})

test('update banner: esc dismisses it when nothing else claims esc', async () => {
  const banner = fakeBanner()
  const { app } = await boot({ updateBanner: banner })
  app.update({ type: 'update.ready', version: '9.9.9' })

  press(app, 'escape')

  assert.equal(banner.state, 'idle')
  assert.doesNotMatch(screen(app), /Update v/)
})

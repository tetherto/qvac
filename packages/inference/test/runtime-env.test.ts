import test from 'brittle'
import { initEnv, getValidatedEnv } from '@/runtime/env'

test('initEnv: homeDir option sets HOME_DIR', (t) => {
  initEnv({ homeDir: '/data/user/home' })
  t.is(getValidatedEnv().HOME_DIR, '/data/user/home')
  initEnv()
})

test('initEnv: without homeDir, HOME_DIR falls back to the user home', (t) => {
  initEnv()
  t.ok(getValidatedEnv().HOME_DIR)
  t.not(getValidatedEnv().HOME_DIR, '/data/user/home')
})

test('initEnv: argv does not change HOME_DIR', (t) => {
  const original = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push('/from/argv/zero', '', JSON.stringify({ HOME_DIR: '/from/argv/two' }))
  try {
    initEnv()
    t.not(getValidatedEnv().HOME_DIR, '/from/argv/zero')
    t.not(getValidatedEnv().HOME_DIR, '/from/argv/two')
  } finally {
    Bare.argv.length = 0
    Bare.argv.push(...original)
    initEnv()
  }
})

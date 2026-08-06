import test from 'brittle'
import { initEnv, getValidatedEnv } from '@/runtime/env'

function withArgv(argv: string[], fn: () => void) {
  const original = Bare.argv.slice()
  Bare.argv.length = 0
  Bare.argv.push(...argv)
  try {
    fn()
  } finally {
    Bare.argv.length = 0
    Bare.argv.push(...original)
    initEnv()
  }
}

test('initEnv: argv[2] JSON overrides HOME_DIR', (t) => {
  withArgv(['react-native-bare-kit', '', JSON.stringify({ HOME_DIR: '/data/user/home' })], () => {
    initEnv()
    t.is(getValidatedEnv().HOME_DIR, '/data/user/home')
  })
})

test('initEnv: non-JSON argv[2] leaves HOME_DIR at its default', (t) => {
  withArgv(['react-native-bare-kit', '', 'not json'], () => {
    initEnv()
    t.ok(getValidatedEnv().HOME_DIR)
    t.not(getValidatedEnv().HOME_DIR, 'not json')
  })
})

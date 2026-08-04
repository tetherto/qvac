import test from 'brittle'
import { z } from 'zod'
import { registerPlugin, clearPlugins, getAllPlugins, hasPlugin } from '@/server/plugins'
import type { QvacPlugin } from '@/schemas/plugin'

function fakePlugin(modelType: string, releaseLogger: () => void): QvacPlugin {
  return {
    modelType,
    displayName: modelType,
    addonPackage: modelType,
    loadConfigSchema: z.object({}),
    async createModel() {
      return undefined
    },
    handlers: {},
    logging: {
      namespace: modelType,
      module: {
        setLogger() {},
        releaseLogger
      }
    }
  } as unknown as QvacPlugin
}

test('clearPlugins releases every plugin and empties the registry even when one releaseLogger throws', (t) => {
  clearPlugins()

  let releasedThrowing = false
  let releasedNext = false

  registerPlugin(
    fakePlugin('clear-plugins-throwing', () => {
      releasedThrowing = true
      throw new Error('release failed')
    })
  )
  registerPlugin(
    fakePlugin('clear-plugins-next', () => {
      releasedNext = true
    })
  )

  t.execution(() => clearPlugins())

  t.ok(releasedThrowing, 'the throwing plugin was released')
  t.ok(releasedNext, 'the sweep continued to the next plugin after the throw')
  t.absent(hasPlugin('clear-plugins-throwing'))
  t.absent(hasPlugin('clear-plugins-next'))
  t.is(getAllPlugins().length, 0, 'the registry is empty after the sweep')
})

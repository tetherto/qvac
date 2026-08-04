import test from 'brittle'
import { z } from 'zod'
import { clearPlugins, registerPlugin, unregisterPlugin } from '@/server/plugins/registry'
import {
  clearAllAddonLoggers,
  createStreamLogger,
  registerAddonLogger,
  unregisterAddonLogger
} from '@/logging'
import {
  clearAllLoggingStreams,
  registerLoggingStream
} from '@/server/bare/registry/logging-stream-registry'
import { ADDON_ASR, ModelType } from '@/schemas'

interface MockLoggingModule {
  setLogger(callback: (priority: number, message: string) => void): void
  releaseLogger(): void
}

function makePlugin(modelType: string, loggingModule: MockLoggingModule) {
  return {
    modelType,
    displayName: modelType,
    addonPackage: ADDON_ASR,
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: {
          load() {
            return Promise.resolve()
          }
        }
      }
    },
    handlers: {},
    logging: {
      module: loggingModule,
      namespace: ADDON_ASR
    }
  }
}

test('shared plugin logging module stays active until its last plugin unregisters', (t) => {
  const modelId = 'shared-asr-logging-lifecycle-test'
  const messages: string[] = []
  let callback: ((priority: number, message: string) => void) | undefined
  let setCalls = 0
  let releaseCalls = 0
  const loggingModule: MockLoggingModule = {
    setLogger(nextCallback) {
      setCalls += 1
      callback = nextCallback
    },
    releaseLogger() {
      releaseCalls += 1
      callback = undefined
    }
  }

  clearPlugins()
  clearAllAddonLoggers()
  clearAllLoggingStreams()
  t.teardown(() => {
    unregisterAddonLogger(modelId)
    clearPlugins()
    clearAllAddonLoggers()
    clearAllLoggingStreams()
  })

  registerLoggingStream(modelId, (_level, _namespace, message) => {
    messages.push(message)
  })
  const logger = createStreamLogger(modelId, ADDON_ASR)
  registerAddonLogger(modelId, ADDON_ASR, logger)

  registerPlugin(makePlugin(ModelType.whispercppTranscription, loggingModule))
  registerPlugin(makePlugin(ModelType.parakeetTranscription, loggingModule))

  t.is(setCalls, 1, 'shared native callback is installed once')
  callback?.(2, 'before unregister')
  t.alike(messages, ['before unregister'])

  t.ok(unregisterPlugin(ModelType.whispercppTranscription))
  t.is(releaseCalls, 0, 'removing Whisper keeps Parakeet logging active')
  callback?.(2, 'after whisper unregister')
  t.alike(messages, ['before unregister', 'after whisper unregister'])

  t.ok(unregisterPlugin(ModelType.parakeetTranscription))
  t.is(releaseCalls, 1, 'last shared-module plugin releases the callback')
  t.is(callback, undefined)
})

test('clearPlugins releases a shared logging module once', (t) => {
  let releaseCalls = 0
  const loggingModule: MockLoggingModule = {
    setLogger() {},
    releaseLogger() {
      releaseCalls += 1
    }
  }

  clearPlugins()
  t.teardown(() => clearPlugins())
  registerPlugin(makePlugin(ModelType.whispercppTranscription, loggingModule))
  registerPlugin(makePlugin(ModelType.parakeetTranscription, loggingModule))

  clearPlugins()
  t.is(releaseCalls, 1)
})

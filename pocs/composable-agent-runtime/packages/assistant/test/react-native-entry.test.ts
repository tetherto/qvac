import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = {
  adapterOptions: null as Record<string, unknown> | null,
  facadeOptions: null as Record<string, unknown> | null
}

vi.mock('../lib/react-native-adapters.ts', () => ({
  createReactNativeAssistantComponents(options: Record<string, unknown>) {
    captured.adapterOptions = options
    return {
      startSync: async () => {
        throw new Error('unused')
      },
      startHarness: async () => {
        throw new Error('unused')
      }
    }
  }
}))

vi.mock('../lib/facade.ts', () => ({
  DEFAULT_ASSISTANT_STORAGE_PATH: '.assistant',
  DEFAULT_ASSISTANT_INFERENCE: { kind: 'qwen' },
  DEFAULT_ASSISTANT_MODEL: 'registry://default-model',
  createAssistantFacade(options: Record<string, unknown>) {
    captured.facadeOptions = options
    return { close: async () => {} }
  }
}))

describe('react-native entry', () => {
  beforeEach(() => {
    captured.adapterOptions = null
    captured.facadeOptions = null
  })

  it('maps default options to react-native adapters', async () => {
    const { createAssistant } = await import('../react-native.ts')
    createAssistant({ logging: { level: 'debug' } })
    expect(captured.adapterOptions).toMatchObject({
      storagePath: '.assistant',
      inference: { kind: 'qwen' }
    })
  })

  it('forwards invite and explicit options to adapters', async () => {
    const { createAssistant } = await import('../react-native.ts')
    createAssistant({
      storagePath: '/tmp/mobile-assistant',
      invite: 'invite-token',
      inference: { kind: 'qwen' },
      logging: { level: 'debug' }
    })
    expect(captured.adapterOptions).not.toHaveProperty('logging')
    expect(captured.adapterOptions).toMatchObject({
      storagePath: '/tmp/mobile-assistant',
      invite: 'invite-token',
      inference: { kind: 'qwen' }
    })
    expect(captured.facadeOptions).toMatchObject({
      storagePath: '/tmp/mobile-assistant',
      invite: 'invite-token',
      inference: { kind: 'qwen' },
      logging: { level: 'debug' }
    })
  })
})

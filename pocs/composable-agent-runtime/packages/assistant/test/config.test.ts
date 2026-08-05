import { describe, expect, it } from 'vitest'
import {
  assistantLogLevel,
  resolveAssistantConfig
} from '../lib/config.ts'

describe('assistant runtime config', () => {
  it('resolves explicit logging over environment values', () => {
    const snapshot = resolveAssistantConfig(
      { level: 'debug' },
      { QVAC_LOG_LEVEL: 'error' }
    )

    expect(assistantLogLevel(snapshot)).toBe('debug')
  })

  it('uses a package-owned logging default', () => {
    expect(assistantLogLevel(resolveAssistantConfig(undefined, {}))).toBe(
      'info'
    )
  })
})

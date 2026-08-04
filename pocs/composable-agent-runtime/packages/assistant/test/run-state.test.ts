import { describe, expect, it } from 'vitest'
import * as Assistant from '../index.ts'

describe('run-state ownership', () => {
  it('does not expose an Assistant-authored persistence adapter', () => {
    expect(Reflect.get(Assistant, 'createRunStateAdapter')).toBeUndefined()
  })
})

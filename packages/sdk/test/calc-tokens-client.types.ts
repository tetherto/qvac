import { calcTokens } from '@/index'

calcTokens({ modelId: 'llm', text: 'Hello' })
calcTokens({ modelId: 'llm', history: [{ role: 'user', content: 'Hello' }] })
calcTokens({ modelId: 'llm', text: 'Hello', history: [] })

// @ts-expect-error A text prompt or non-empty history is required.
calcTokens({ modelId: 'llm' })

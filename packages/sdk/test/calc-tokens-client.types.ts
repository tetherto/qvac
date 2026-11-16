import { calcTokens, completion } from '@/index'

const history: Parameters<typeof completion>[0]['history'] = [{ role: 'user', content: 'Hello' }]

calcTokens({ modelId: 'llm', text: 'Hello' })
calcTokens({ modelId: 'llm', history })
calcTokens({ modelId: 'llm', text: 'Hello', history: [] })

// @ts-expect-error A text prompt or non-empty history is required.
calcTokens({ modelId: 'llm' })

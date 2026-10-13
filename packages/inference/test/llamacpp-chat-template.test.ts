import test from 'brittle'

const context = (resolved: string[]) => ({
  resolveModelPath: async (src: unknown) => {
    resolved.push(String(src))
    return '/cache/chat_template.jinja'
  },
  modelSrc: '/models/model.gguf',
  modelType: 'llamacpp-completion'
})

test('llamacpp completion plugin hands a resolved chat template to the addon', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')
  const resolved: string[] = []

  const result = await llmPlugin.resolveConfig!(
    { chatTemplateSrc: 'https://example.com/chat_template.jinja', ctx_size: 4096 },
    context(resolved)
  )
  const config = result.config as Record<string, unknown>

  t.alike(resolved, ['https://example.com/chat_template.jinja'])
  t.is(config['chat_template_file'], '/cache/chat_template.jinja')
  t.absent(config['chatTemplateSrc'], 'the source itself never reaches the addon')
  t.is(config['ctx_size'], 4096)
})

test('llamacpp completion plugin keeps the GGUF template when none is given', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')
  const resolved: string[] = []

  const result = await llmPlugin.resolveConfig!({ ctx_size: 4096 }, context(resolved))
  const config = result.config as Record<string, unknown>

  t.alike(resolved, [])
  t.absent(config['chat_template_file'])
})

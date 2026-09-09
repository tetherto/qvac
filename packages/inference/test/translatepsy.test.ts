import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getLanguage, translate } from '@/plugins/ops/translate'
import { isTranslatePsyModel } from '@/plugins/ops/translatepsy-utils'
import {
  AFRICAN_LANGUAGES_MAP,
  llmConfigSchema,
  ModelType,
  type TranslateParams
} from '@/schemas/index'

const expectedMessages = [
  {
    role: 'system',
    content:
      'You are a professional English to Swahili translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Swahili grammar, vocabulary, and cultural sensitivities. Produce only the Swahili translation, without any additional explanations or commentary. '
  },
  {
    role: 'user',
    content:
      'Please translate the following English text into Swahili: How are you today?.\n\nTranslation:'
  }
]

const expectedOptions = {
  generationParams: {
    temp: 0,
    top_k: 1,
    top_p: 1,
    repeat_penalty: 1,
    predict: 256,
    seed: 0,
    reasoning_budget: 0
  }
}

let nextId = 0
async function runTranslation(
  local: { path: string; name?: string },
  params: Partial<TranslateParams> = {}
) {
  const modelId = `translatepsy-test-${++nextId}`
  const calls: unknown[][] = []
  const config = llmConfigSchema.parse({})
  registerModel(modelId, {
    ...local,
    config,
    modelType: ModelType.llamacppCompletion,
    model: {
      async run(...args: unknown[]) {
        calls.push(args)
        return {
          async *iterate() {
            yield 'Habari'
          },
          async cancel() {}
        }
      }
    } as unknown as AnyModel
  })
  const tokens = []
  try {
    for await (const token of translate({
      modelId,
      modelType: ModelType.llamacppCompletion,
      stream: true,
      text: 'How are you today?',
      from: 'en',
      to: 'swh_Latn',
      ...params
    } as TranslateParams)) {
      tokens.push(token)
    }
    return { calls, config, tokens }
  } finally {
    unregisterModel(modelId)
  }
}

for (const size of ['0.8', '2', '4']) {
  for (const quant of ['Q4_K_M', 'Q8_0']) {
    const filename = `TranslatePsy-AfriSLM-${size}B-${quant}-imat.gguf`
    test(`translate: ${filename} sends the exact model-card prompt and verified settings`, async (t) => {
      for (const path of [`/models/${filename}`, `/cache/0123456789abcdef_${filename}`]) {
        const result = await runTranslation(
          { path },
          { context: 'Use a casual tone and explain your answer.' }
        )
        t.alike(result.calls, [[expectedMessages, expectedOptions]])
        t.alike(result.tokens, ['Habari'])
        t.is(result.config.ctx_size, 1024, 'retains the SDK context default')
        t.absent(result.config.tools, 'does not require tool calling')
      }
    })
  }
}

test('translate: registry name selects TranslatePsy with an opaque local filename', async (t) => {
  const result = await runTranslation({
    name: 'TRANSLATEPSY_AFRISLM_2B_Q8_0_IMAT',
    path: '/cache/model.gguf'
  })
  t.alike(result.calls, [[expectedMessages, expectedOptions]])
})

test('translate: detects the source language before building the TranslatePsy prompt', async (t) => {
  const result = await runTranslation(
    { path: '/models/TranslatePsy-AfriSLM-2B-Q8_0-imat.gguf' },
    { from: undefined, to: 'sw' }
  )
  t.alike(result.calls, [[expectedMessages, expectedOptions]])
})

test('translate: resolves the new languages in both prompt roles and preserves input whitespace', async (t) => {
  const result = await runTranslation(
    { path: '/models/TranslatePsy-AfriSLM-4B-Q4_K_M-imat.gguf' },
    { from: 'lin_Latn', to: 'wo', text: '  Mbote!\n' }
  )
  t.alike(result.calls, [
    [
      [
        {
          role: 'system',
          content:
            'You are a professional Lingala to Wolof translator. Your goal is to accurately convey the meaning and nuances of the original Lingala text while adhering to Wolof grammar, vocabulary, and cultural sensitivities. Produce only the Wolof translation, without any additional explanations or commentary. '
        },
        {
          role: 'user',
          content:
            'Please translate the following Lingala text into Wolof:   Mbote!\n.\n\nTranslation:'
        }
      ],
      expectedOptions
    ]
  ])
})

test('translate: family matching excludes unrelated models and parent directory names', (t) => {
  for (const path of [
    '/models/Qwen3.5-4B-Q8_0.gguf',
    '/models/AfriqueGemma-4B.Q4_K_M.gguf',
    '/models/TranslatePsy-AfriSLM-4B-Q4_K_M-imat.gguf/unrelated.gguf',
    '/models/Other-TranslatePsy-AfriSLM-4B-Q8_0-imat.gguf'
  ]) {
    t.is(isTranslatePsyModel({ path }), false, path)
  }
  t.is(isTranslatePsyModel({ name: 'TRANSLATEPSY_AFRISLMOTHER_2B', path: 'model.gguf' }), false)
  t.ok(isTranslatePsyModel({ path: 'C:\\models\\TranslatePsy-AfriSLM-2B-Q8_0-imat.gguf' }))
})

test('translate: existing generic and AfriqueGemma prompts keep their decoding behavior', async (t) => {
  const generic = await runTranslation(
    { path: '/models/other.gguf' },
    { to: 'es', context: 'Use a formal tone' }
  )
  t.alike(generic.calls, [
    [
      [
        {
          role: 'system',
          content:
            'Use a formal tone. Translate the following text from English into Spanish. Only output the translation, nothing else.\n\nEnglish: How are you today?\nSpanish:'
        }
      ],
      {
        generationParams: {
          temp: 0,
          top_k: 1,
          top_p: 1,
          repeat_penalty: 1.3,
          seed: 42,
          predict: 256
        }
      }
    ]
  ])
  const afrique = await runTranslation({
    name: 'AFRICAN_4B_TRANSLATION_Q4_K_M',
    path: '/models/AfriqueGemma-4B.Q4_K_M.gguf'
  })
  t.alike(afrique.calls, [
    [
      [
        {
          role: 'user',
          content: 'Translate English to Swahili.\nEnglish: How are you today?\nSwahili:'
        }
      ]
    ]
  ])
})

test('translate: adding language names does not expand Afrique prompt selection', async (t) => {
  // This baseline changes only when prompt behavior intentionally changes.
  const legacyAfriqueCodes = new Set([
    'afr_Latn',
    'swh_Latn',
    'ary_Arab',
    'som_Latn',
    'amh_Ethi',
    'arz_Arab',
    'hau_Latn',
    'kin_Latn',
    'zul_Latn',
    'ibo_Latn',
    'plt_Latn',
    'xho_Latn',
    'sna_Latn',
    'yor_Latn',
    'nya_Latn',
    'sot_Latn',
    'tir_Ethi',
    'aeb_Arab',
    'gaz_Latn',
    'tsn_Latn'
  ])
  const codes = new Set([...legacyAfriqueCodes, ...AFRICAN_LANGUAGES_MAP.keys()])
  for (const code of codes) {
    for (const direction of ['from', 'to']) {
      const from = direction === 'from' ? code : 'en'
      const to = direction === 'to' ? code : 'en'
      const result = await runTranslation(
        { path: '/models/other.gguf' },
        { from, to, context: 'Use a formal tone' }
      )
      const fromLanguage = getLanguage(from)
      const toLanguage = getLanguage(to)
      const afrique = legacyAfriqueCodes.has(code)
      t.alike(
        result.calls[0]?.[0],
        [
          {
            role: afrique ? 'user' : 'system',
            content: afrique
              ? `Translate ${fromLanguage} to ${toLanguage}.\n${fromLanguage}: How are you today?\n${toLanguage}:`
              : `Use a formal tone. Translate the following text from ${fromLanguage} into ${toLanguage}. Only output the translation, nothing else.\n\n${fromLanguage}: How are you today?\n${toLanguage}:`
          }
        ],
        `${direction}=${code}`
      )
    }
  }
})

for (const local of [
  { name: 'GENERIC', path: '/models/other.gguf' },
  { name: 'AFRICAN_4B_TRANSLATION_Q4_K_M', path: '/models/AfriqueGemma-4B.Q4_K_M.gguf' }
]) {
  test(`translate: ${local.name} keeps context and the generic prompt for Lingala, Luganda, and Wolof`, async (t) => {
    for (const [language, ...codes] of [
      ['Lingala', 'ln', 'lin', 'lin_Latn'],
      ['Luganda', 'lg', 'lug', 'lug_Latn'],
      ['Wolof', 'wo', 'wol', 'wol_Latn']
    ]) {
      for (const code of codes) {
        for (const direction of ['from', 'to']) {
          const from = direction === 'from' ? code : 'en'
          const to = direction === 'to' ? code : 'en'
          const fromLanguage = direction === 'from' ? language : 'English'
          const toLanguage = direction === 'to' ? language : 'English'
          const result = await runTranslation(local, { from, to, context: 'Use a formal tone' })
          const messages = [
            {
              role: 'system',
              content: `Use a formal tone. Translate the following text from ${fromLanguage} into ${toLanguage}. Only output the translation, nothing else.\n\n${fromLanguage}: How are you today?\n${toLanguage}:`
            }
          ]
          const expectedCall =
            local.name === 'GENERIC'
              ? [
                  messages,
                  {
                    generationParams: {
                      temp: 0,
                      top_k: 1,
                      top_p: 1,
                      repeat_penalty: 1.3,
                      seed: 42,
                      predict: 256
                    }
                  }
                ]
              : [messages]
          t.alike(result.calls, [expectedCall], `${direction}=${code}`)
        }
      }
    }
  })
}

test('translate: resolves full language names from ISO and script-qualified codes', (t) => {
  const languages = [
    ['English', 'en', 'eng', 'eng_Latn'],
    ['Afrikaans', 'af', 'afr', 'afr_Latn'],
    ['Amharic', 'am', 'amh', 'amh_Ethi'],
    ['Hausa', 'ha', 'hau', 'hau_Latn'],
    ['Igbo', 'ig', 'ibo', 'ibo_Latn'],
    ['Kinyarwanda', 'rw', 'kin', 'kin_Latn'],
    ['Lingala', 'ln', 'lin', 'lin_Latn'],
    ['Luganda', 'lg', 'lug', 'lug_Latn'],
    ['Plateau Malagasy', 'mg', 'mlg', 'plt', 'plt_Latn'],
    ['Nyanja', 'ny', 'nya', 'nya_Latn'],
    ['Oromo', 'om', 'orm', 'gaz', 'gaz_Latn'],
    ['Shona', 'sn', 'sna', 'sna_Latn'],
    ['Somali', 'so', 'som', 'som_Latn'],
    ['Southern Sotho', 'st', 'sot', 'sot_Latn'],
    ['Swahili', 'sw', 'swa', 'swh', 'swh_Latn'],
    ['Tswana', 'tn', 'tsn', 'tsn_Latn'],
    ['Wolof', 'wo', 'wol', 'wol_Latn'],
    ['Xhosa', 'xh', 'xho', 'xho_Latn'],
    ['Yoruba', 'yo', 'yor', 'yor_Latn'],
    ['Zulu', 'zu', 'zul', 'zul_Latn']
  ]
  for (const [name, ...codes] of languages) {
    for (const code of codes) t.is(getLanguage(code), name, code)
  }
  t.is(getLanguage('es'), 'Spanish')
  t.is(getLanguage('unknown'), 'UNKNOWN')
  t.is(getLanguage(undefined), '')
})

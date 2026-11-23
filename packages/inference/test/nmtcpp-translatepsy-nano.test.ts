import test from 'brittle'
import {
  detectTranslatePsyNanoPack,
  resolveTranslatePsyNanoPack,
  assertTranslatePsyNanoLanguages,
  withTargetTag
} from '@/plugins/builtin/nmtcpp-translation/translatepsy-nano'
import { nmtFilesFor, nmtParamsFor } from '@/plugins/builtin/nmtcpp-translation/load-files'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { translate } from '@/plugins/ops/translate'
import { ModelType, nmtConfigSchema, type ModelSrcInput, type NmtConfig } from '@/schemas'

const AFRI = 'qvac/TranslatePsy-AfriNano/resolve/7a793aac03e34b31f53388c22eda26ae108c58e5'
const EURO = 'qvac/TranslatePsy-EuroNano/resolve/3a5e1e4e2f7001ff5cfd79785bef03cf19281b73'
const AFRI_EN_XX = `registry://hf/${AFRI}/en-xx/Base/intgemm/model.intgemm.alphas.bin`
const AFRI_XX_EN = `registry://hf/${AFRI}/xx-en/Tiny/intgemm/model.intgemm.alphas.bin`
const EURO_EN_XX = `registry://hf/${EURO}/en-xx/BaseMemory/intgemm/model.intgemm.alphas.bin`
const BERGAMOT_DE_EN =
  'registry://s3/qvac_models_compiled/bergamot/bergamot-deen/2025-12-18/model.deen.intgemm.alphas.bin'
const BERGAMOT_EN_IT =
  'registry://s3/qvac_models_compiled/bergamot/bergamot-enit/2025-12-18/model.enit.intgemm.alphas.bin'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('detect: registry paths and the Hugging Face layout', (t) => {
  t.alike(detectTranslatePsyNanoPack(AFRI_EN_XX), { family: 'AfriNano', direction: 'en-xx' })
  t.alike(detectTranslatePsyNanoPack(EURO_EN_XX), { family: 'EuroNano', direction: 'en-xx' })
  t.alike(
    detectTranslatePsyNanoPack(
      `https://huggingface.co/${EURO}/xx-en/Base/intgemm/model.intgemm.alphas.bin`
    ),
    { family: 'EuroNano', direction: 'xx-en' }
  )
  t.alike(
    detectTranslatePsyNanoPack(
      '/home/u/.cache/huggingface/hub/models--qvac--TranslatePsy-AfriNano/snapshots/7a79/en-xx/Tiny/intgemm/model.intgemm.alphas.bin'
    ),
    { family: 'AfriNano', direction: 'en-xx' },
    'Hub cache snapshot'
  )
  t.alike(
    detectTranslatePsyNanoPack(
      'C:\\models\\TranslatePsy-EuroNano\\en-xx\\Base\\intgemm\\model.intgemm.alphas.bin'
    ),
    { family: 'EuroNano', direction: 'en-xx' },
    'Windows path'
  )
  t.alike(
    detectTranslatePsyNanoPack('./packs/en-xx/BaseMemory/intgemm/model.intgemm.alphas.bin'),
    { direction: 'en-xx' },
    'layout without the repo directory: direction only'
  )
})

test('detect: plain Bergamot models and renamed copies are not Nano packs', (t) => {
  t.is(detectTranslatePsyNanoPack(BERGAMOT_DE_EN), null)
  t.is(detectTranslatePsyNanoPack('/models/sw/model.intgemm.alphas.bin'), null)
  t.is(detectTranslatePsyNanoPack('pear://abc123/model.intgemm.alphas.bin'), null)
  t.is(detectTranslatePsyNanoPack(`${AFRI}/en-xx/Base/fp32/model.npz.best-chrf.npz`), null)
})

test('resolve: targetTag forces or disables Nano handling', (t) => {
  const renamed = '/models/sw/model.intgemm.alphas.bin'
  t.alike(resolveTranslatePsyNanoPack({ targetTag: true, modelSrc: renamed }), {
    direction: 'en-xx'
  })
  t.is(resolveTranslatePsyNanoPack({ targetTag: false, modelSrc: AFRI_EN_XX }), null)
  t.alike(resolveTranslatePsyNanoPack({ modelSrc: AFRI_EN_XX }), {
    family: 'AfriNano',
    direction: 'en-xx'
  })
  t.exception(
    () => resolveTranslatePsyNanoPack({ targetTag: true, modelSrc: AFRI_XX_EN }),
    /xx-en pack, which takes no tag/
  )
})

// ---------------------------------------------------------------------------
// Language validation
// ---------------------------------------------------------------------------

test('languages: each pack accepts its own family and direction', (t) => {
  const afriEnXx = { family: 'AfriNano', direction: 'en-xx' } as const
  const euroXxEn = { family: 'EuroNano', direction: 'xx-en' } as const
  for (const to of ['am', 'ha', 'ig', 'ln', 'so', 'sw', 'yo', 'zu']) {
    assertTranslatePsyNanoLanguages(afriEnXx, 'en', to, false)
  }
  for (const from of ['de', 'es', 'fr', 'it', 'pt', 'fi', 'cs', 'nl', 'sv']) {
    assertTranslatePsyNanoLanguages(euroXxEn, from, 'en', false)
  }
  // Family unknown (renamed copy forced with targetTag): either family's targets.
  assertTranslatePsyNanoLanguages({ direction: 'en-xx' }, 'en', 'sv', false)
  assertTranslatePsyNanoLanguages({ direction: 'en-xx' }, 'en', 'yo', false)
  t.pass()
})

test('languages: wrong family, wrong direction and X→Y are rejected with the fix', (t) => {
  const afriEnXx = { family: 'AfriNano', direction: 'en-xx' } as const
  const afriXxEn = { family: 'AfriNano', direction: 'xx-en' } as const
  t.exception(
    () => assertTranslatePsyNanoLanguages(afriEnXx, 'en', 'de', false),
    /TranslatePsy-AfriNano en-xx packs translate into am, ha, ig, ln, so, sw, yo, zu, got to: 'de'/
  )
  t.exception(
    () => assertTranslatePsyNanoLanguages(afriEnXx, 'sw', 'en', false),
    /Load the xx-en pack for sw→en/
  )
  t.exception(
    () => assertTranslatePsyNanoLanguages(afriXxEn, 'en', 'sw', false),
    /Load the en-xx pack for en→sw/
  )
  t.exception(
    () => assertTranslatePsyNanoLanguages(afriXxEn, 'sw', 'yo', false),
    /load an xx-en pack \(sw→en\) and an en-xx pack \(en→yo\) and translate twice: pivotModel cannot carry the ##YO target tag/
  )
  t.exception(
    () => assertTranslatePsyNanoLanguages(afriEnXx, 'en', 'sw', true),
    /cannot be the first leg of a pivotModel load/
  )
  t.exception(
    () => assertTranslatePsyNanoLanguages({ direction: 'en-xx' }, 'en', 'ja', false),
    /TranslatePsy Nano en-xx packs translate into/
  )
})

// ---------------------------------------------------------------------------
// nmtPlugin.resolveConfig
// ---------------------------------------------------------------------------

function ctxFor(modelSrc: string, modelName?: string) {
  const resolved: string[] = []
  return {
    resolved,
    ctx: {
      modelSrc,
      modelType: 'nmtcpp-translation',
      ...(modelName !== undefined && { modelName }),
      resolveModelPath: async (src: ModelSrcInput) => {
        resolved.push(String(src))
        return String(src)
      }
    }
  }
}

async function resolveConfig(
  config: Record<string, unknown>,
  modelSrc: string,
  modelName?: string
) {
  const { nmtPlugin } = await import('@/plugins/builtin/nmtcpp-translation/plugin')
  const { ctx, resolved } = ctxFor(modelSrc, modelName)
  const result = await nmtPlugin.resolveConfig!({ engine: 'Bergamot', ...config }, ctx)
  return { config: result.config as Record<string, unknown>, artifacts: result.artifacts, resolved }
}

test('resolveConfig: a registry en-xx pack resolves to targetTag and the companion-set vocab', async (t) => {
  const { config, artifacts, resolved } = await resolveConfig(
    { from: 'en', to: 'sw' },
    AFRI_EN_XX,
    'TRANSLATEPSY_AFRINANO_EN_XX_BASE'
  )
  t.is(config['targetTag'], true)
  t.absent(artifacts, 'vocab comes from the companion set beside the model')
  t.alike(resolved, [])
})

test('resolveConfig: a local en-xx pack derives its colocated vocab.spm', async (t) => {
  const dir = '/data/TranslatePsy-EuroNano/en-xx/Tiny/intgemm/'
  const { config, artifacts } = await resolveConfig(
    { from: 'en', to: 'pt' },
    `${dir}model.intgemm.alphas.bin`
  )
  t.is(config['targetTag'], true)
  t.alike(artifacts, { srcVocabPath: `${dir}vocab.spm`, dstVocabPath: `${dir}vocab.spm` })
})

test('resolveConfig: an xx-en pack takes no tag', async (t) => {
  const dir = '/data/TranslatePsy-AfriNano/xx-en/Base/intgemm/'
  const { config, artifacts } = await resolveConfig(
    { from: 'yo', to: 'en' },
    `${dir}model.intgemm.alphas.bin`
  )
  t.absent(config['targetTag'])
  t.alike(artifacts, { srcVocabPath: `${dir}vocab.spm`, dstVocabPath: `${dir}vocab.spm` })
})

test('resolveConfig: rejects a mismatched pack before anything loads', async (t) => {
  await t.exception(
    resolveConfig({ from: 'en', to: 'de' }, AFRI_EN_XX),
    /TranslatePsy-AfriNano en-xx packs translate into/
  )
  await t.exception(resolveConfig({ from: 'en', to: 'de' }, AFRI_XX_EN), /Load the en-xx pack/)
  await t.exception(resolveConfig({ from: 'de', to: 'sw' }, EURO_EN_XX), /translate twice/)
})

test('resolveConfig: pivoting into an en-xx pack is rejected, out of an xx-en pack is allowed', async (t) => {
  await t.exception(
    resolveConfig({ from: 'de', to: 'sw', pivotModel: { modelSrc: AFRI_EN_XX } }, BERGAMOT_DE_EN),
    /pivotModel .* is a TranslatePsy Nano en-xx pack/
  )
  const { config } = await resolveConfig(
    { from: 'sw', to: 'it', pivotModel: { modelSrc: BERGAMOT_EN_IT } },
    AFRI_XX_EN
  )
  t.absent(config['targetTag'])
  t.ok(config['pivotModel'])
})

test('resolveConfig: targetTag false loads a detected pack as plain Bergamot', async (t) => {
  const { config } = await resolveConfig({ from: 'en', to: 'de', targetTag: false }, AFRI_EN_XX)
  t.is(config['targetTag'], false)
})

test('resolveConfig: targetTag true tags a renamed copy', async (t) => {
  const { config, artifacts } = await resolveConfig(
    { from: 'en', to: 'ha', targetTag: true },
    '/app/assets/afri-en/model.intgemm.alphas.bin'
  )
  t.is(config['targetTag'], true)
  t.alike(artifacts, {
    srcVocabPath: '/app/assets/afri-en/vocab.spm',
    dstVocabPath: '/app/assets/afri-en/vocab.spm'
  })
})

test('resolveConfig: a registry name alone does not make a pack (loads share by source)', async (t) => {
  // Loads with the same modelSrc and modelConfig share one model whatever their
  // name, so tagging must follow the source: a renamed copy stays plain.
  const { config } = await resolveConfig(
    { from: 'en', to: 'de' },
    '/app/assets/euro-en/model.intgemm.alphas.bin',
    'TRANSLATEPSY_EURONANO_EN_XX_TINY'
  )
  t.absent('targetTag' in config)
})

test('resolveConfig: plain Bergamot is unchanged', async (t) => {
  const { config } = await resolveConfig({ from: 'de', to: 'en' }, BERGAMOT_DE_EN, 'BERGAMOT_DE_EN')
  t.absent('targetTag' in config)
})

// ---------------------------------------------------------------------------
// Addon construction
// ---------------------------------------------------------------------------

test('nmtFilesFor: a pair-less pack uses the shared vocab.spm beside it', (t) => {
  t.alike(nmtFilesFor('/cache/sets/0123456789abcdef/model.intgemm.alphas.bin', {}), {
    model: '/cache/sets/0123456789abcdef/model.intgemm.alphas.bin',
    srcVocab: '/cache/sets/0123456789abcdef/vocab.spm',
    dstVocab: '/cache/sets/0123456789abcdef/vocab.spm'
  })
})

test('nmtParamsFor: a tagged pack keeps the addon Opus-MT pair token out of the input', (t) => {
  const tagged = nmtConfigSchema.parse({
    engine: 'Bergamot',
    from: 'en',
    to: 'pt',
    targetTag: true
  }) as NmtConfig
  t.alike(nmtParamsFor(tagged), { srcLang: 'en', dstLang: 'xx' })
  const plain = nmtConfigSchema.parse({ engine: 'Bergamot', from: 'en', to: 'pt' }) as NmtConfig
  t.alike(nmtParamsFor(plain), { srcLang: 'en', dstLang: 'pt' }, 'Firefox en-pt keeps >>por<<')
})

// ---------------------------------------------------------------------------
// translate op
// ---------------------------------------------------------------------------

test('withTargetTag: prepends once and respects an existing tag', (t) => {
  t.is(withTargetTag('Good morning', '##SW'), '##SW Good morning')
  t.is(withTargetTag('##SW Good morning', '##SW'), '##SW Good morning')
  t.is(withTargetTag('##YO Good morning', '##SW'), '##YO Good morning', 'per-input override')
  t.is(withTargetTag('##sw is lower-case', '##SW'), '##SW ##sw is lower-case')
  t.is(withTargetTag('#hashtag', '##SW'), '##SW #hashtag')
})

let nextId = 0
function registerNmt(config: Record<string, unknown>) {
  const modelId = `nano-${++nextId}`
  const inputs: unknown[] = []
  registerModel(modelId, {
    model: {
      run: async (input: string) => {
        inputs.push(input)
        return {
          stats: {},
          await: async () => ['out'],
          iterate: async function* () {
            yield 'out'
          },
          cancel: async () => {}
        }
      },
      runBatch: async (texts: string[]) => {
        inputs.push(texts)
        return texts.map(() => 'out')
      }
    } as unknown as AnyModel,
    path: '/cache/sets/0123456789abcdef/model.intgemm.alphas.bin',
    config,
    modelType: ModelType.nmtcppTranslation
  })
  return { modelId, inputs }
}

async function drain(modelId: string, text: string | string[], stream: boolean) {
  const gen = translate(
    { modelId, text, stream, modelType: ModelType.nmtcppTranslation } as never,
    `req-${modelId}-${stream}`
  )
  for (let next = await gen.next(); !next.done; next = await gen.next()) {
    // drain
  }
}

test('translate: a tagged pack prepends ##<TO> to single, streamed and batched input', async (t) => {
  const { modelId, inputs } = registerNmt({
    engine: 'Bergamot',
    from: 'en',
    to: 'sw',
    targetTag: true
  })
  try {
    await drain(modelId, 'Good morning', false)
    await drain(modelId, 'Good morning', true)
    await drain(modelId, ['One', '##YO Two', '##SW Three'], false)
    t.alike(inputs, [
      '##SW Good morning',
      '##SW Good morning',
      ['##SW One', '##YO Two', '##SW Three']
    ])
  } finally {
    unregisterModel(modelId)
  }
})

test('translate: untagged Bergamot input is sent unchanged', async (t) => {
  const { modelId, inputs } = registerNmt({ engine: 'Bergamot', from: 'en', to: 'sw' })
  const off = registerNmt({ engine: 'Bergamot', from: 'en', to: 'sw', targetTag: false })
  try {
    await drain(modelId, 'Good morning', false)
    await drain(modelId, ['One'], false)
    await drain(off.modelId, 'Good morning', true)
    t.alike(inputs, ['Good morning', ['One']])
    t.alike(off.inputs, ['Good morning'])
  } finally {
    unregisterModel(modelId)
    unregisterModel(off.modelId)
  }
})

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('schema: Bergamot accepts the AfriNano languages and targetTag', (t) => {
  for (const code of ['am', 'ha', 'ig', 'ln', 'so', 'sw', 'yo', 'zu', 'fi', 'cs', 'nl', 'sv']) {
    t.ok(nmtConfigSchema.safeParse({ engine: 'Bergamot', from: 'en', to: code }).success, code)
  }
  const parsed = nmtConfigSchema.parse({
    engine: 'Bergamot',
    from: 'en',
    to: 'zu',
    targetTag: true
  })
  t.is((parsed as { targetTag?: boolean }).targetTag, true)
  t.absent(
    nmtConfigSchema.safeParse({ engine: 'Bergamot', from: 'en', to: 'sw', targetTag: 'yes' })
      .success
  )
})

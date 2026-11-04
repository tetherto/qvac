'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const process = require('bare-process')
const {
  FILE_ALIAS_TABLE,
  normalizeGgmlFiles,
  findQuantRankedGguf,
  firstNonEmpty
} = require('../../lib/modelFiles.js')
const { AUDIO8_LM_RE } = require('../../lib/engines/audio8.js')

global.process = process

function withTempDir(name, body) {
  const root = path.join(
    os.tmpdir(),
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  fs.mkdirSync(root, { recursive: true })
  try {
    return body(root)
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch (_e) {}
  }
}

test('model files: every alias collapses onto its canonical key', (t) => {
  const files = normalizeGgmlFiles({
    t3: '/a/t3.gguf',
    t3ModelPath: '',
    s3genModelPath: '/a/s3.gguf',
    supertonic: '/a/st.gguf',
    parler: '/a/p.gguf',
    audio8LmPath: '/a/lm.gguf',
    mossBackbonePath: '/a/bb.gguf',
    mossSoundEffectPath: '/a/sfx.gguf',
    mossSpeechModelPath: '/a/sp.gguf',
    mossSpeechCodecPath: '/a/spc.gguf',
    cosyvoiceLlmModelPath: '/a/llm.gguf',
    mecabDictPath: '/a/dict',
    cangjieTsv: '/a/cj.tsv'
  })
  t.is(files.t3Model, '/a/t3.gguf', 'an empty alias is skipped')
  t.is(files.s3genModel, '/a/s3.gguf')
  t.is(files.supertonicModel, '/a/st.gguf')
  t.is(files.parlerModel, '/a/p.gguf')
  t.is(files.audio8Lm, '/a/lm.gguf')
  t.is(files.mossBackbone, '/a/bb.gguf')
  t.is(files.mossSoundEffect, '/a/sfx.gguf')
  t.is(files.mossSpeechModel, '/a/sp.gguf')
  t.is(files.mossSpeechCodec, '/a/spc.gguf')
  t.is(files.cosyvoiceLlmModel, '/a/llm.gguf')
  t.is(files.mecabDictDir, '/a/dict')
  t.is(files.cangjieTsvPath, '/a/cj.tsv')
  t.is(
    normalizeGgmlFiles({ t3Model: '/canon.gguf', t3ModelPath: '/alias.gguf' }).t3Model,
    '/canon.gguf',
    'the canonical key wins over its alias'
  )
  t.alike(normalizeGgmlFiles(null), {})
  t.alike(normalizeGgmlFiles('not an object'), {})
})

test('model files: the alias table routes every alias to its canonical key, canonical first', (t) => {
  const canonicalKeys = FILE_ALIAS_TABLE.map((row) => row[0])
  const aliasKeys = FILE_ALIAS_TABLE.flatMap((row) => row.slice(1))
  t.is(new Set(canonicalKeys).size, canonicalKeys.length, 'one row per canonical key')
  t.is(new Set(aliasKeys).size, aliasKeys.length, 'no alias is listed twice')
  for (const alias of aliasKeys) {
    t.absent(canonicalKeys.includes(alias), `${alias} is an alias, not a canonical key`)
  }
  for (const [canonical, ...aliases] of FILE_ALIAS_TABLE) {
    t.is(
      normalizeGgmlFiles({ [canonical]: `/${canonical}` })[canonical],
      `/${canonical}`,
      `${canonical} passes through`
    )
    for (const alias of aliases) {
      t.is(
        normalizeGgmlFiles({ [alias]: `/${alias}` })[canonical],
        `/${alias}`,
        `${alias} lands on ${canonical}`
      )
    }
    if (aliases.length === 0) continue
    const aliasValues = Object.fromEntries(aliases.map((key) => [key, `/${key}`]))
    t.is(
      normalizeGgmlFiles({ [canonical]: `/${canonical}`, ...aliasValues })[canonical],
      `/${canonical}`,
      `${canonical} beats its aliases`
    )
    t.is(
      normalizeGgmlFiles({ [canonical]: '', ...aliasValues })[canonical],
      `/${aliases[0]}`,
      `${canonical}: an empty canonical value falls through to the first alias`
    )
  }
  t.alike(
    Object.keys(normalizeGgmlFiles({})),
    canonicalKeys,
    'the normalized object lists every canonical key in table order'
  )
})

test('model files: quant-ranked discovery prefers q8_0, f16, q4_0, f32, then anything else', (t) => {
  withTempDir('tts-ggml-quant', (root) => {
    const order = ['iq2', 'f32', 'q4_0', 'f16', 'q8_0']
    for (const quant of order) fs.writeFileSync(path.join(root, `audio8-lm-${quant}.gguf`), quant)
    const expected = ['q8_0', 'f16', 'q4_0', 'f32', 'iq2']
    for (const quant of expected) {
      t.is(findQuantRankedGguf(root, AUDIO8_LM_RE), path.join(root, `audio8-lm-${quant}.gguf`))
      fs.rmSync(path.join(root, `audio8-lm-${quant}.gguf`))
    }
    t.absent(findQuantRankedGguf(root, AUDIO8_LM_RE), 'nothing left to find')
    fs.writeFileSync(path.join(root, 'audio8-lm-q4_0.gguf'), 'q4')
    fs.writeFileSync(path.join(root, 'audio8-lm.gguf'), 'bare')
    t.is(
      findQuantRankedGguf(root, AUDIO8_LM_RE),
      path.join(root, 'audio8-lm.gguf'),
      'a bare single-tier file ranks above every quant'
    )
  })
  t.absent(findQuantRankedGguf(undefined, AUDIO8_LM_RE))
  t.absent(findQuantRankedGguf('/does/not/exist', AUDIO8_LM_RE))
})

test('model files: firstNonEmpty skips null, undefined and empty strings only', (t) => {
  t.is(firstNonEmpty(undefined, '', null, 0, 5), 0)
  t.is(firstNonEmpty(false, true), false)
  t.absent(firstNonEmpty('', null, undefined))
})

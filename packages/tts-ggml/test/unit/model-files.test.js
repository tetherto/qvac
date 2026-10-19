'use strict'

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const process = require('bare-process')
const {
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

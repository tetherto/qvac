/**
 * Tests for bergamot-model-fetcher BCP 47 language code normalization.
 *
 * Firefox Remote Settings uses BCP 47 tags (`zh-Hans`); QVAC and Mozilla's
 * `firefox-translations-models` repo use ISO 639-1 short codes (`zh`). The
 * filter that selects Firefox records for download had been failing silently
 * for Chinese pairs because `zh !== 'zh-Hans'`.
 */

const test = require('brittle')
const {
  normalizeBcp47Lang,
  getBergamotFileNames
} = require('../../lib/bergamot-model-fetcher')

test('normalizeBcp47Lang maps zh to zh-Hans for Firefox Remote Settings', (t) => {
  t.is(normalizeBcp47Lang('zh'), 'zh-Hans')
})

test('normalizeBcp47Lang returns unmapped codes unchanged', (t) => {
  for (const lang of ['en', 'es', 'fr', 'ja', 'ko', 'ar', 'th', 'vi', 'no', 'nb', 'nn']) {
    t.is(normalizeBcp47Lang(lang), lang)
  }
})

test('getBergamotFileNames builds the CJK split-vocab filenames for zh target', (t) => {
  const names = getBergamotFileNames('en', 'zh')
  t.is(names.modelName, 'model.enzh.intgemm.alphas.bin')
  t.is(names.lexName, 'lex.50.50.enzh.s2t.bin')
  t.is(names.srcVocabName, 'srcvocab.enzh.spm')
  t.is(names.dstVocabName, 'trgvocab.enzh.spm')
})

test('getBergamotFileNames uses single vocab for non-CJK targets', (t) => {
  const names = getBergamotFileNames('en', 'fr')
  t.is(names.srcVocabName, 'vocab.enfr.spm')
  t.is(names.dstVocabName, 'vocab.enfr.spm')
})

'use strict'

const test = require('brittle')
const languages = require('../../supportedLanguages')

/**
 * Test that all language family lists are exported and non-empty.
 */
test('All language family lists are exported', async t => {
  t.ok(Array.isArray(languages.latinLangList), 'latinLangList should be an array')
  t.ok(Array.isArray(languages.arabicLangList), 'arabicLangList should be an array')
  t.ok(Array.isArray(languages.bengaliLangList), 'bengaliLangList should be an array')
  t.ok(Array.isArray(languages.cyrillicLangList), 'cyrillicLangList should be an array')
  t.ok(Array.isArray(languages.devanagariLangList), 'devanagariLangList should be an array')
  t.ok(Array.isArray(languages.otherLangList), 'otherLangList should be an array')
  t.ok(typeof languages.otherLangStringMap === 'object', 'otherLangStringMap should be an object')
  t.ok(Array.isArray(languages.onnxOcrAllSupportedLanguages), 'onnxOcrAllSupportedLanguages should be an array')
})

test('Language lists are non-empty', async t => {
  t.ok(languages.latinLangList.length > 0, 'latinLangList should not be empty')
  t.ok(languages.arabicLangList.length > 0, 'arabicLangList should not be empty')
  t.ok(languages.bengaliLangList.length > 0, 'bengaliLangList should not be empty')
  t.ok(languages.cyrillicLangList.length > 0, 'cyrillicLangList should not be empty')
  t.ok(languages.devanagariLangList.length > 0, 'devanagariLangList should not be empty')
  t.ok(languages.otherLangList.length > 0, 'otherLangList should not be empty')
})

/**
 * Test that key languages are present in the right lists.
 */
test('Latin list contains common Latin-script languages', async t => {
  const expected = ['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'pl', 'sv', 'tr']
  for (const lang of expected) {
    t.ok(languages.latinLangList.includes(lang), `latinLangList should contain '${lang}'`)
  }
})

test('Arabic list contains expected languages', async t => {
  const expected = ['ar', 'fa', 'ug', 'ur']
  for (const lang of expected) {
    t.ok(languages.arabicLangList.includes(lang), `arabicLangList should contain '${lang}'`)
  }
  t.is(languages.arabicLangList.length, 4, 'Arabic list should have exactly 4 languages')
})

test('Bengali list contains expected languages', async t => {
  const expected = ['bn', 'as', 'mni']
  for (const lang of expected) {
    t.ok(languages.bengaliLangList.includes(lang), `bengaliLangList should contain '${lang}'`)
  }
  t.is(languages.bengaliLangList.length, 3, 'Bengali list should have exactly 3 languages')
})

test('Cyrillic list contains expected languages', async t => {
  const expected = ['ru', 'be', 'bg', 'uk', 'mn']
  for (const lang of expected) {
    t.ok(languages.cyrillicLangList.includes(lang), `cyrillicLangList should contain '${lang}'`)
  }
})

test('Devanagari list contains expected languages', async t => {
  const expected = ['hi', 'mr', 'ne']
  for (const lang of expected) {
    t.ok(languages.devanagariLangList.includes(lang), `devanagariLangList should contain '${lang}'`)
  }
})

test('Other language list contains expected languages', async t => {
  const expected = ['th', 'ch_sim', 'ch_tra', 'ja', 'ko', 'ta', 'te', 'kn']
  for (const lang of expected) {
    t.ok(languages.otherLangList.includes(lang), `otherLangList should contain '${lang}'`)
  }
  t.is(languages.otherLangList.length, 8, 'Other lang list should have exactly 8 languages')
})

/**
 * Test that otherLangStringMap maps to correct model names.
 */
test('otherLangStringMap has correct model name mappings', async t => {
  t.is(languages.otherLangStringMap.th, 'thai', 'th should map to thai')
  t.is(languages.otherLangStringMap.ch_tra, 'zh_tra', 'ch_tra should map to zh_tra')
  t.is(languages.otherLangStringMap.ch_sim, 'zh_sim', 'ch_sim should map to zh_sim')
  t.is(languages.otherLangStringMap.ja, 'japanese', 'ja should map to japanese')
  t.is(languages.otherLangStringMap.ko, 'korean', 'ko should map to korean')
  t.is(languages.otherLangStringMap.ta, 'tamil', 'ta should map to tamil')
  t.is(languages.otherLangStringMap.te, 'telugu', 'te should map to telugu')
  t.is(languages.otherLangStringMap.kn, 'kannada', 'kn should map to kannada')
})

/**
 * Test that onnxOcrAllSupportedLanguages is the union of all language lists.
 */
test('onnxOcrAllSupportedLanguages contains all languages from every family', async t => {
  const allLists = [
    ...languages.latinLangList,
    ...languages.arabicLangList,
    ...languages.bengaliLangList,
    ...languages.cyrillicLangList,
    ...languages.devanagariLangList,
    ...languages.otherLangList
  ]

  t.is(languages.onnxOcrAllSupportedLanguages.length, allLists.length,
    'Total count should equal sum of all lists')

  for (const lang of allLists) {
    t.ok(languages.onnxOcrAllSupportedLanguages.includes(lang),
      `onnxOcrAllSupportedLanguages should contain '${lang}'`)
  }
})

/**
 * Test that there are no duplicate languages across lists.
 */
test('No duplicate languages in onnxOcrAllSupportedLanguages', async t => {
  const unique = new Set(languages.onnxOcrAllSupportedLanguages)
  t.is(unique.size, languages.onnxOcrAllSupportedLanguages.length,
    'Should have no duplicate language codes')
})

/**
 * Test that every language in otherLangList has a corresponding otherLangStringMap entry.
 */
test('Every language in otherLangList has a mapping in otherLangStringMap', async t => {
  for (const lang of languages.otherLangList) {
    t.ok(languages.otherLangStringMap[lang],
      `'${lang}' in otherLangList should have a mapping in otherLangStringMap`)
  }
})

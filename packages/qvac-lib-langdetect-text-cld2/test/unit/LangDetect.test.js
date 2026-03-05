'use strict'

const test = require('brittle')
const { detectOne, detectMultiple, getLangName, getISO2FromName } = require('../..')

test('Should detect one language for English text', async (t) => {
  const text = 'This is a simple test sentence in English.'
  const result = await detectOne(text)
  t.ok(result, 'Result should not be empty')
  t.is(typeof result, 'object', 'Result should be an object')
  t.is(typeof result.code, 'string', 'Result code should be a string')
  t.is(result.code.length, 2, 'Result code should be a 2-letter ISO code')
  t.is(typeof result.language, 'string', 'Result language should be a string')
  t.comment(`Detected language: ${result.language} (code: ${result.code})`)

  t.is(result.code, 'en', 'Expected the ISO639-1 code to be "en" for English')
  t.is(result.language, 'English', 'Expected the detected language to be "English"')
})

test('Should detect multiple languages (topK=2)', async (t) => {
  const text = 'Bonjour, this is a mixed language text.'
  const topK = 2
  const results = await detectMultiple(text, topK)

  t.is(Array.isArray(results), true, 'detectMultiple should return an array')
  t.ok(results.length <= topK && results.length > 0, `Should return at most ${topK} results`)
  t.comment(JSON.stringify(results, null, 2))

  // Check for expected language codes
  // If the text is predominantly recognized as French or English
  t.ok(
    results.some(r => r.language === 'French') ||
    results.some(r => r.language === 'English'),
    'Should detect either French or English in the results'
  )
})

test('Should return "Undetermined" for empty text in detectOne', async (t) => {
  const result = await detectOne('')

  t.is(typeof result, 'object', 'detectOne should return an object')
  t.is(result.code, 'und', 'Code should be "und" for undetermined text')
  t.is(result.language, 'Undetermined', 'Language should be "Undetermined" for empty text')
})

test('Should return array with "Undetermined" for empty text in detectMultiple', async (t) => {
  const results = await detectMultiple('')

  t.is(Array.isArray(results), true, 'Should still return an array')
  t.is(results.length, 1, 'Array should contain exactly one element')
  t.is(results[0].code, 'und', 'Code should be "und"')
  t.is(results[0].language, 'Undetermined', 'Language should be "Undetermined"')
  t.is(results[0].probability, 1, 'Probability should be 1')
})

test('Should handle invalid topK values in detectMultiple', async (t) => {
  const text = 'Hello world'

  const results1 = await detectMultiple(text, 0)
  t.is(Array.isArray(results1), true, 'detectMultiple should return an array')
  t.ok(results1.length > 0, 'Should default to topK=3 if 0 is provided')

  const results2 = await detectMultiple(text, -5)
  t.is(Array.isArray(results2), true, 'detectMultiple should return an array')
  t.ok(results2.length > 0, 'Should default to topK=3 if negative is provided')
})

test('Should return an array of language probabilities in detectMultiple', async (t) => {
  const text = 'Hello. Bonjour. Hola.'
  const results = await detectMultiple(text, 3)

  t.is(Array.isArray(results), true, 'Return value should be an array')
  t.ok(results.length > 0, 'Should return at least one language result')

  for (const item of results) {
    t.is(typeof item.code, 'string', 'Each item should have a language code (string)')
    t.is(typeof item.language, 'string', 'Each item should have a language name (string)')
    t.is(typeof item.probability, 'number', 'Each item should have a numeric probability')
  }
  t.comment(JSON.stringify(results, null, 2))
})

test('Should get language name from ISO2 code', (t) => {
  // Test with valid ISO2 codes
  t.is(getLangName('en'), 'English', 'Should return "English" for "en"')
  t.is(getLangName('fr'), 'French', 'Should return "French" for "fr"')
  t.is(getLangName('es'), 'Spanish, Castilian', 'Should return "Spanish, Castilian" for "es"')

  // Test case insensitive
  t.is(getLangName('EN'), 'English', 'Should handle uppercase input')
  t.is(getLangName('Fr'), 'French', 'Should handle mixed case input')
})

test('Should get language name from ISO3 code', (t) => {
  // Test with valid ISO3 codes
  t.is(getLangName('eng'), 'English', 'Should return "English" for "eng"')
  t.is(getLangName('fra'), 'French', 'Should return "French" for "fra"')
  t.is(getLangName('spa'), 'Spanish, Castilian', 'Should return "Spanish, Castilian" for "spa"')

  // Test case insensitive
  t.is(getLangName('ENG'), 'English', 'Should handle uppercase input')
  t.is(getLangName('Fra'), 'French', 'Should handle mixed case input')
})

test('Should handle invalid codes in getLangName', (t) => {
  // Test invalid inputs
  t.is(getLangName(''), null, 'Should return null for empty string')
  t.is(getLangName('   '), null, 'Should return null for whitespace')
  t.is(getLangName('invalid'), null, 'Should return null for invalid code')
  t.is(getLangName('xx'), null, 'Should return null for non-existent ISO2')
  t.is(getLangName('xxx'), null, 'Should return null for non-existent ISO3')
  t.is(getLangName(null), null, 'Should return null for null')
  t.is(getLangName(undefined), null, 'Should return null for undefined')
  t.is(getLangName(123), null, 'Should return null for number input')
})

test('Should get ISO2 code from language name', (t) => {
  // Test with valid language names
  t.is(getISO2FromName('English'), 'en', 'Should return "en" for "English"')
  t.is(getISO2FromName('French'), 'fr', 'Should return "fr" for "French"')
  t.is(getISO2FromName('Spanish, Castilian'), 'es', 'Should return "es" for "Spanish, Castilian"')

  // Test case insensitive
  t.is(getISO2FromName('english'), 'en', 'Should handle lowercase input')
  t.is(getISO2FromName('FRENCH'), 'fr', 'Should handle uppercase input')
  t.is(getISO2FromName('spanish, castilian'), 'es', 'Should handle mixed case input')
})

test('Should handle invalid language names in getISO2FromName', (t) => {
  // Test invalid inputs
  t.is(getISO2FromName(''), null, 'Should return null for empty string')
  t.is(getISO2FromName('   '), null, 'Should return null for whitespace')
  t.is(getISO2FromName('Undetermined Language'), null, 'Should return null for unknown language')
  t.is(getISO2FromName('Nonexistent'), null, 'Should return null for nonexistent language')
  t.is(getISO2FromName(null), null, 'Should return null for null input')
  t.is(getISO2FromName(undefined), null, 'Should return null for undefined input')
  t.is(getISO2FromName(123), null, 'Should return null for number input')
})

test('Should handle edge cases with whitespace in new functions', (t) => {
  // Test whitespace handling in getLangName
  t.is(getLangName(' en '), 'English', 'Should trim whitespace in getLangName')
  t.is(getLangName('  eng  '), 'English', 'Should trim whitespace in getLangName for ISO3')

  // Test whitespace handling in getISO2FromName
  t.is(getISO2FromName(' English '), 'en', 'Should trim whitespace in getISO2FromName')
  t.is(getISO2FromName('  French  '), 'fr', 'Should trim whitespace in getISO2FromName')
})

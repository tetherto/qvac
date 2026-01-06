'use strict'

const test = require('brittle')
const { tokenizeText, estimateTokenCount } = require('../../src/adapters/chunker/Tokenizer')

test('Tokenizer: should detect Unicode property support correctly', t => {
  const result = tokenizeText('test')
  t.ok(result, 'Should successfully tokenize when detecting Unicode support')
  t.ok(Array.isArray(result.tokens), 'Should return valid token structure')

  const count = estimateTokenCount('test')
  t.ok(typeof count === 'number' && count > 0, 'Should successfully estimate when detecting Unicode support')
})

test('tokenizeText: should return tokens and total count', t => {
  const text = 'Hello world'
  const result = tokenizeText(text)

  t.ok(result, 'Result should exist')
  t.ok(Array.isArray(result.tokens), 'Tokens should be an array')
  t.ok(typeof result.total === 'number', 'Total should be a number')
  t.ok(result.total > 0, 'Total should be greater than 0')
  t.ok(result.tokens.length > 0, 'Should have tokens')

  result.tokens.forEach((token, index) => {
    t.ok(typeof token.text === 'string', `Token ${index} should have text property`)
    t.ok(typeof token.count === 'number', `Token ${index} should have count property`)
    t.ok(token.count > 0, `Token ${index} count should be positive`)
  })

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Tokens should reconstruct original text')
})

test('estimateTokenCount: should return positive number for valid text', t => {
  const text = 'Hello world'
  const count = estimateTokenCount(text)

  t.ok(typeof count === 'number', 'Should return a number')
  t.ok(count > 0, 'Should return positive count')
  t.ok(Number.isInteger(count), 'Should return integer count')
})

test('Tokenizer: tokenizeText.total should match estimateTokenCount', t => {
  const testTexts = [
    'Hello world',
    'The quick brown fox jumps over the lazy dog.',
    "Don't forget: testing is important!",
    'Visit https://example.com for more info.',
    'Multiple\nlines\nof\ntext',
    '🚀 Emoji test 💯',
    'Mix of 123 numbers and text!'
  ]

  testTexts.forEach(text => {
    const tokenized = tokenizeText(text)
    const estimated = estimateTokenCount(text)
    t.is(tokenized.total, estimated, `Counts should match for: "${text}"`)
  })
})

test('Tokenizer: should handle ASCII text correctly', t => {
  const text = 'Hello world! This is a test with 123 numbers and punctuation.'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 5, 'Should create multiple tokens')
  t.ok(result.total > 5, 'Should have reasonable token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct ASCII text perfectly')
})

test('Tokenizer: should handle Unicode characters', t => {
  const text = 'Hello 世界 café résumé naïve'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 0, 'Should create tokens for Unicode text')
  t.ok(result.total > 0, 'Should have positive token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct Unicode text perfectly')
})

test('Tokenizer: should handle emoji characters', t => {
  const text = 'Hello 🌟 world 🚀 test 💯'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 0, 'Should create tokens for emoji text')
  t.ok(result.total > 0, 'Should have positive token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct emoji text perfectly')
})

test('Tokenizer: should handle URLs correctly', t => {
  const text = 'Visit https://example.com/path?param=value#section for info'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 3, 'URL should be tokenized into multiple parts')
  t.ok(result.total > 3, 'Should have reasonable token count for URLs')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct URL text perfectly')
})

test('Tokenizer: should handle email addresses', t => {
  const text = 'Contact us at test@example.com or support@domain.org'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 5, 'Email addresses should be tokenized')
  t.ok(result.total > 5, 'Should have reasonable token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct email text perfectly')
})

test('Tokenizer: should handle markdown syntax', t => {
  const text = '# Heading\n\n**Bold** and *italic* text with [link](url)'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 8, 'Markdown should create multiple tokens')
  t.ok(result.total > 8, 'Should have reasonable token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct markdown perfectly')
})

test('Tokenizer: should handle contractions correctly', t => {
  const text = "Don't can't won't it's they're we'll I'd"
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 7, 'Contractions should be tokenized appropriately')
  t.ok(result.total > 7, 'Should have reasonable token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct contractions perfectly')
})

test('Tokenizer: should handle various whitespace correctly', t => {
  const text = 'Word1   Word2\t\tWord3\n\nWord4\r\nWord5'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 5, 'Should tokenize across different whitespace')
  t.ok(result.total > 5, 'Should have reasonable token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should preserve all whitespace types')
})

test('Tokenizer: should handle numbers and special characters', t => {
  const text = 'Price: $19.99, Code: ABC123, Date: 2024-01-15, Time: 14:30:45'
  const result = tokenizeText(text)

  t.ok(result.tokens.length > 10, 'Numbers and symbols should be tokenized')
  t.ok(result.total > 10, 'Should have reasonable token count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Should reconstruct numbers and symbols perfectly')
})

test('Tokenizer: should handle empty and minimal text', t => {
  const emptyResult = tokenizeText('')
  t.is(emptyResult.tokens.length, 0, 'Empty string should have no tokens')
  t.is(emptyResult.total, 0, 'Empty string should have zero count')

  const spaceResult = tokenizeText('   ')
  t.ok(spaceResult.tokens.length > 0, 'Whitespace should create tokens')
  t.ok(spaceResult.total > 0, 'Whitespace should have positive count')

  const singleResult = tokenizeText('a')
  t.ok(singleResult.tokens.length > 0, 'Single character should create token')
  t.ok(singleResult.total > 0, 'Single character should have positive count')
})

test('tokenizeText: should accept custom weights', t => {
  const text = 'Hello world test'
  const customWeights = {
    lettersDivisor: 2.0,
    globalBias: 1.5
  }

  const defaultResult = tokenizeText(text)
  const customResult = tokenizeText(text, customWeights)

  t.ok(customResult.total !== defaultResult.total, 'Custom weights should affect token count')
  t.ok(customResult.tokens.length === defaultResult.tokens.length, 'Token count should be same')

  const reconstructed = customResult.tokens.map(t => t.text).join('')
  t.is(reconstructed, text, 'Custom weights should not affect reconstruction')
})

test('estimateTokenCount: should accept custom weights', t => {
  const text = 'Hello world test'
  const customWeights = {
    lettersDivisor: 2.0,
    globalBias: 1.5
  }

  const defaultCount = estimateTokenCount(text)
  const customCount = estimateTokenCount(text, customWeights)

  t.ok(customCount !== defaultCount, 'Custom weights should affect estimation')
  t.ok(typeof customCount === 'number', 'Should still return number')
  t.ok(customCount > 0, 'Should still return positive count')
})

test('Tokenizer: should handle moderately large text efficiently', t => {
  const largeText = 'The quick brown fox jumps over the lazy dog. '.repeat(100)

  const start = Date.now()
  const result = tokenizeText(largeText)
  const duration = Date.now() - start

  t.ok(result.tokens.length > 100, 'Should tokenize large text')
  t.ok(result.total > 100, 'Should have reasonable token count')
  t.ok(duration < 1000, 'Should complete within reasonable time (< 1s)')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, largeText, 'Should reconstruct large text perfectly')
})

test('Tokenizer: should produce consistent results across runs', t => {
  const text = 'Consistency test with 123 numbers and special chars!'

  const results = []
  for (let i = 0; i < 5; i++) {
    results.push(tokenizeText(text))
  }

  for (let i = 1; i < results.length; i++) {
    t.is(results[i].total, results[0].total, `Run ${i} total should match first run`)
    t.is(results[i].tokens.length, results[0].tokens.length, `Run ${i} token count should match`)

    for (let j = 0; j < results[i].tokens.length; j++) {
      t.is(results[i].tokens[j].text, results[0].tokens[j].text, `Run ${i} token ${j} text should match`)
      t.is(results[i].tokens[j].count, results[0].tokens[j].count, `Run ${i} token ${j} count should match`)
    }
  }
})

test('Tokenizer: should maintain accurate token boundaries', t => {
  const text = 'Word1 Word2\tWord3\nWord4'
  const result = tokenizeText(text)

  result.tokens.forEach((token, index) => {
    t.ok(token.text.length > 0, `Token ${index} should not be empty`)
    t.ok(token.count > 0, `Token ${index} should have positive count`)
  })

  const hasWordLikeTokens = result.tokens.some(t => t.text.includes('Word'))
  t.ok(hasWordLikeTokens, 'Should identify word-like patterns correctly')
})

test('Tokenizer: should handle complex Unicode correctly', t => {
  const complexUnicode = '🤚🏾👨‍👩‍👧‍👦 👍🏿 🇺🇸 café naïve résumé 北京 東京 москва'

  const result = tokenizeText(complexUnicode)
  t.ok(result.tokens.length > 0, 'Should handle complex Unicode')
  t.ok(result.total > 0, 'Should have positive count')

  const reconstructed = result.tokens.map(t => t.text).join('')
  t.is(reconstructed, complexUnicode, 'Should reconstruct complex Unicode perfectly')
})

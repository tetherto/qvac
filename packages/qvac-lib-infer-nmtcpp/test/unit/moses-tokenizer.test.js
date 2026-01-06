/**
 * Tests for MosesTokenizer and MosesDetokenizer
 */

const test = require('brittle')
const {
  MosesTokenizer,
  MosesDetokenizer
} = require('../../third-party/indic-processor-deps/sacremoses')

test('MosesTokenizer should tokenize a sentence correctly', (t) => {
  const moses = new MosesTokenizer()

  // Tokenize a sentence with weird symbols
  const text =
    'This, is a sentence with weird\xbb symbols\u2026 appearing everywhere\xbf'
  const expectedTokens =
    'This , is a sentence with weird \xbb symbols \u2026 appearing everywhere \xbf'
  const tokenizedText = moses.tokenize(text, false, true) // returnStr=true
  t.is(tokenizedText, expectedTokens)
})

test('MosesTokenizer should tokenize nonbreaking prefixes correctly', (t) => {
  const moses = new MosesTokenizer()

  // The nonbreaking prefixes should tokenize the final fullstop
  t.alike(moses.tokenize('abc def.'), ['abc', 'def', '.'])

  // Should handle situation when numeric only prefix is the last token
  t.alike(moses.tokenize('2016, pp.'), ['2016', ',', 'pp', '.'])
})

test('MosesTokenizer should handle XML escaping correctly', (t) => {
  const moses = new MosesTokenizer()
  const text =
    "This ain't funny. It's actually hillarious, yet double Ls. | [] < > [ ] & You're gonna shake it off? Don't?"
  const expectedTokensWithXmlEscape = [
    'This',
    'ain',
    '&apos;t',
    'funny',
    '.',
    'It',
    '&apos;s',
    'actually',
    'hillarious',
    ',',
    'yet',
    'double',
    'Ls',
    '.',
    '&#124;',
    '&#91;',
    '&#93;',
    '&lt;',
    '&gt;',
    '&#91;',
    '&#93;',
    '&amp;',
    'You',
    '&apos;re',
    'gonna',
    'shake',
    'it',
    'off',
    '?',
    'Don',
    '&apos;t',
    '?'
  ]
  const expectedTokensWoXmlEscape = [
    'This',
    'ain',
    "'t",
    'funny',
    '.',
    'It',
    "'s",
    'actually',
    'hillarious',
    ',',
    'yet',
    'double',
    'Ls',
    '.',
    '|',
    '[',
    ']',
    '<',
    '>',
    '[',
    ']',
    '&',
    'You',
    "'re",
    'gonna',
    'shake',
    'it',
    'off',
    '?',
    'Don',
    "'t",
    '?'
  ]

  t.alike(
    moses.tokenize(text, false, false, true),
    expectedTokensWithXmlEscape
  )
  t.alike(moses.tokenize(text, false, false, false), expectedTokensWoXmlEscape)
})

test('MosesTokenizer, should handle single quotes correctly', (t) => {
  const moses = new MosesTokenizer()
  const text = "this 'is' the thing"
  const expectedTokens = ['this', '&apos;', 'is', '&apos;', 'the', 'thing']
  t.alike(moses.tokenize(text, false, false, true), expectedTokens)
})

test('MosesTokenizer, should handle aggressive dash splitting', (t) => {
  const moses = new MosesTokenizer()
  const expectedTokensWoAggressiveDashSplit = ['foo-bar']
  const expectedTokensWithAggressiveDashSplit = ['foo', '@-@', 'bar']

  t.alike(moses.tokenize('foo-bar'), expectedTokensWoAggressiveDashSplit)
  t.alike(
    moses.tokenize('foo-bar', true),
    expectedTokensWithAggressiveDashSplit
  )
})

test('MosesTokenizer, should handle opening brackets correctly', (t) => {
  const moses = new MosesTokenizer()
  const text =
    'By the mid 1990s a version of the game became a Latvian television series (with a parliamentary setting, and played by Latvian celebrities).'
  const expectedTokens =
    'By the mid 1990s a version of the game became a Latvian television series ( with a parliamentary setting , and played by Latvian celebrities ) .'.split(
      ' '
    )
  t.alike(moses.tokenize(text), expectedTokens)
})

test('MosesTokenizer, should handle dot splitting correctly', (t) => {
  const moses = new MosesTokenizer()
  const text = 'The meeting will take place at 11:00 a.m. Tuesday.'
  const expectedTokens =
    'The meeting will take place at 11 : 00 a.m. Tuesday .'.split(' ')
  t.alike(moses.tokenize(text), expectedTokens)
})

test('MosesTokenizer, should handle trailing dot apostrophe correctly', (t) => {
  const moses = new MosesTokenizer()
  const text = "'Hello.'"
  const expectedTokens = '&apos;Hello . &apos;'.split(' ')
  t.alike(moses.tokenize(text), expectedTokens)
})

test('MosesTokenizer, should protect patterns correctly', (t) => {
  const moses = new MosesTokenizer()
  const text =
    'this is a webpage https://stackoverflow.com/questions/6181381/how-to-print-variables-in-perl that kicks ass'
  const expectedTokens = [
    'this',
    'is',
    'a',
    'webpage',
    'https://stackoverflow.com/questions/6181381/how-to-print-variables-in-perl',
    'that',
    'kicks',
    'ass'
  ]

  // Test with BASIC_PROTECTED_PATTERNS
  t.alike(
    moses.tokenize(text, false, false, true, moses.BASIC_PROTECTED_PATTERNS),
    expectedTokens
  )

  // Testing against pattern from issues
  const noePatterns = [
    /(?:http|ftp)s?:\/\/(?:(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+(?:[A-Z]{2,6}\.?|[A-Z0-9-]{2,}\.?))(?::\d+)?(?:\/\w+)*(?:(?:\.[a-z]+)|\/?)(?:\?[^\s]*)?(?:#[^\s]*)?/i
  ]

  t.alike(
    moses.tokenize(text, false, false, true, noePatterns),
    expectedTokens
  )
})

test('MosesTokenizer, should protect overlapping patterns with longest match first', (t) => {
  const moses = new MosesTokenizer()
  const patterns = [
    /\w+(,\w+)+,of/g, // protects "this,type,of"
    /\w+(-\w+)+/g // protects "of-sentence-thingy"
  ]
  const text = 'What about a this,type,of-s-thingy?'
  const expected = ['What', 'about', 'a', 'this,type,of-s-thingy', '?']

  // Test with patterns in original order
  t.alike(moses.tokenize(text, false, false, true, patterns), expected)

  // Test with patterns in reversed order - should give same result
  t.alike(
    moses.tokenize(text, false, false, true, [...patterns].reverse()),
    expected
  )
})

test('MosesTokenizer, should split final comma after numbers correctly', (t) => {
  const moses = new MosesTokenizer()
  const text =
    'Sie sollten vor dem Upgrade eine Sicherung dieser Daten erstellen (wie unter Abschnitt 4.1.1, "Sichern aller Daten und Konfigurationsinformationen" beschrieben). '
  const expectedTokens = [
    'Sie',
    'sollten',
    'vor',
    'dem',
    'Upgrade',
    'eine',
    'Sicherung',
    'dieser',
    'Daten',
    'erstellen',
    '(',
    'wie',
    'unter',
    'Abschnitt',
    '4.1.1',
    ',',
    '&quot;',
    'Sichern',
    'aller',
    'Daten',
    'und',
    'Konfigurationsinformationen',
    '&quot;',
    'beschrieben',
    ')',
    '.'
  ]

  t.alike(moses.tokenize(text), expectedTokens)
})

test('MosesTokenizer, should handle Japanese tokenization correctly', (t) => {
  const tokenizer = new MosesTokenizer('ja')
  const text = '電話でんわの邪魔じゃまをしないでください'
  t.alike(tokenizer.tokenize(text), [text])
})

test('MosesTokenizer, should handle Chinese tokenization correctly', (t) => {
  const tokenizer = new MosesTokenizer('zh')
  const text = '记者 应谦 美国'
  t.alike(tokenizer.tokenize(text), ['记者', '应谦', '美国'])
})

test('MosesDetokenizer, should detokenize correctly', (t) => {
  const tokenizer = new MosesTokenizer()
  const detokenizer = new MosesDetokenizer()

  const text =
    'This, is a sentence with weird\xbb symbols\u2026 appearing everywhere\xbf'
  const expectedTokens = tokenizer.tokenize(text)
  const expectedDetokens =
    'This, is a sentence with weird \xbb symbols \u2026 appearing everywhere \xbf'

  t.is(detokenizer.detokenize(expectedTokens), expectedDetokens)
})

test('MosesDetokenizer, should detokenize with XML escaping correctly', (t) => {
  const tokenizer = new MosesTokenizer()
  const detokenizer = new MosesDetokenizer()

  const text =
    "This ain't funny. It's actually hillarious, yet double Ls. | [] < > [ ] & You're gonna shake it off? Don't?"
  const expectedTokens = [
    'This',
    'ain',
    '&apos;t',
    'funny',
    '.',
    'It',
    '&apos;s',
    'actually',
    'hillarious',
    ',',
    'yet',
    'double',
    'Ls',
    '.',
    '&#124;',
    '&#91;',
    '&#93;',
    '&lt;',
    '&gt;',
    '&#91;',
    '&#93;',
    '&amp;',
    'You',
    '&apos;re',
    'gonna',
    'shake',
    'it',
    'off',
    '?',
    'Don',
    '&apos;t',
    '?'
  ]
  const expectedDetokens =
    "This ain't funny. It's actually hillarious, yet double Ls. | [] < > [] & You're gonna shake it off? Don't?"

  t.alike(tokenizer.tokenize(text), expectedTokens)
  t.is(detokenizer.detokenize(expectedTokens), expectedDetokens)
})

test('MosesDetokenizer, should detokenize with aggressive dash splitting correctly', (t) => {
  const tokenizer = new MosesTokenizer()
  const detokenizer = new MosesDetokenizer()

  const text = 'foo-bar'
  t.is(detokenizer.detokenize(tokenizer.tokenize(text, true)), text)
})

test('MosesDetokenizer, should handle opening brackets in detokenization', (t) => {
  const tokenizer = new MosesTokenizer()
  const detokenizer = new MosesDetokenizer()

  const text =
    'By the mid 1990s a version of the game became a Latvian television series (with a parliamentary setting, and played by Latvian celebrities).'
  t.is(detokenizer.detokenize(tokenizer.tokenize(text)), text)
})

test('MosesDetokenizer, should handle French apostrophes correctly', (t) => {
  const tokenizer = new MosesTokenizer('fr')
  const detokenizer = new MosesDetokenizer('fr')

  const text = "L'amitié nous a fait forts d'esprit"
  t.is(detokenizer.detokenize(tokenizer.tokenize(text)), text)
})

test('MosesDetokenizer, should handle Korean tokenization correctly', (t) => {
  const tokenizer = new MosesTokenizer('ko')
  const detokenizer = new MosesDetokenizer('ko')
  const text = '세계 에서 가장 강력한.'

  t.alike(tokenizer.tokenize(text), ['세계', '에서', '가장', '강력한', '.'])
  console.log(detokenizer.detokenize(tokenizer.tokenize(text)), text)
  t.is(detokenizer.detokenize(tokenizer.tokenize(text)), text)
})

test('MosesDetokenizer, should handle mixed CJK tokenization correctly', (t) => {
  const tokenizer = new MosesTokenizer()
  const detokenizer = new MosesDetokenizer()
  const text = 'Japan is 日本 in Japanese.'

  t.alike(tokenizer.tokenize(text), [
    'Japan',
    'is',
    '日',
    '本',
    'in',
    'Japanese',
    '.'
  ])
  console.log(detokenizer.detokenize(tokenizer.tokenize(text)), text)
  t.is(detokenizer.detokenize(tokenizer.tokenize(text)), text)
})

'use strict'

/**
 * Regression test for QVAC-16488 — the Moses tokenizer's
 * Unicode-property tables and nonbreaking-prefix lists must be
 * loadable on every platform.
 *
 * Background: previously this data was loaded at runtime via
 * `require.asset() + bare-fs.readFileSync()`. That worked on
 * desktop but failed on mobile because `bare-pack --linked` did
 * not embed the .txt file contents into the worker bundle's
 * virtual filesystem. The catch-and-continue error handler then
 * silently fell back to empty tables, which broke IndicTrans
 * tokenization (mobile chrF++ collapsed from ~62.5% to 22.8%).
 *
 * The fix moved the data into a plain JS module (`./data.js`) that
 * is loaded via standard `require()`. This test guards against any
 * future regression where the data path could end up empty again
 * — these assertions would all start failing, immediately and
 * loudly, before a release ever shipped.
 *
 * The test runs offline, with no network and no native addon.
 */

const test = require('brittle')
const {
  Perluniprops,
  NonbreakingPrefixes
} = require('../../third-party/indic-processor-deps/sacremoses/pernuliprops')

// ---------------------------------------------------------------------------
// Perluniprops — Unicode character categories
// ---------------------------------------------------------------------------

test('Perluniprops: IsAlnum yields a substantial number of characters (regression: not empty)', (t) => {
  const p = new Perluniprops()
  const chars = [...p.chars('IsAlnum')]
  // The Unicode alnum class contains thousands of code points.
  // Anything < 1000 means we have effectively no data, which is
  // exactly the broken-mobile state we are guarding against.
  t.ok(chars.length > 1000, `IsAlnum should have > 1000 chars, got ${chars.length}`)
})

test('Perluniprops: IsN (Unicode Number) contains common digits', (t) => {
  const p = new Perluniprops()
  const chars = new Set(p.chars('IsN'))
  // Plain ASCII digits should always be in IsN.
  for (const d of '0123456789') {
    t.ok(chars.has(d), `IsN should contain digit '${d}'`)
  }
  t.ok(chars.size > 100, `IsN should be large (got ${chars.size})`)
})

test('Perluniprops: every category that tokenizer.js asks for is non-empty', (t) => {
  // These are the exact categories MosesTokenizer constructs at
  // initialization time. If any of them returns empty, MosesTokenizer
  // builds broken regexes and translation quality silently degrades.
  const expected = [
    'IsAlnum', 'IsAlpha', 'IsLower', 'IsN', 'IsPf', 'IsPi',
    'IsSc', 'IsSo', 'IsUpper'
  ]
  const p = new Perluniprops()
  for (const category of expected) {
    const chars = [...p.chars(category)]
    t.ok(chars.length > 0, `category ${category} must not be empty`)
  }
})

test('Perluniprops: unknown category returns an empty iterable (not throw)', (t) => {
  // We removed the filesystem read path, so "unknown" can only mean
  // a category-name typo. Behaviour should still be the same as the
  // old catch-and-fallback path: empty, no exception.
  const p = new Perluniprops()
  const chars = [...p.chars('CategoryThatDoesNotExist')]
  t.is(chars.length, 0)
})

test('Perluniprops: chars() result is cached (same instance returns same data)', (t) => {
  const p = new Perluniprops()
  const first = [...p.chars('IsN')]
  const second = [...p.chars('IsN')]
  t.alike(first, second)
})

// ---------------------------------------------------------------------------
// NonbreakingPrefixes — Moses tokenizer's per-language abbreviation lists
// ---------------------------------------------------------------------------

test('NonbreakingPrefixes: English contains common abbreviations', (t) => {
  const np = new NonbreakingPrefixes()
  const enPrefixes = new Set(np.getWordsAsArray('en'))
  // These are stable upstream — common single-letter initials and
  // a couple of abbreviations the tokenizer must keep intact.
  for (const expected of ['A', 'B', 'C', 'Adj', 'Adv']) {
    t.ok(enPrefixes.has(expected), `en nonbreaking prefixes should contain '${expected}'`)
  }
  t.ok(enPrefixes.size > 50, `en nonbreaking prefixes should have > 50 entries (got ${enPrefixes.size})`)
})

test('NonbreakingPrefixes: Hindi prefixes (the IndicTrans target language) are populated', (t) => {
  const np = new NonbreakingPrefixes()
  const hiPrefixes = np.getWordsAsArray('hi')
  // Empty hi prefixes is exactly what was happening on mobile —
  // the QVAC-16488 root cause. > 0 is enough to confirm the data
  // path works; the existing integration test's chrF++ assertion
  // is the quality guard.
  t.ok(hiPrefixes.length > 0, `hi nonbreaking prefixes must not be empty (got ${hiPrefixes.length})`)
})

test('NonbreakingPrefixes: language-name aliases work (english → en)', (t) => {
  const np = new NonbreakingPrefixes()
  const fromCode = np.getWordsAsArray('en')
  const fromName = np.getWordsAsArray('english')
  t.alike(fromCode, fromName)
})

test('NonbreakingPrefixes: unknown lang falls back to English', (t) => {
  const np = new NonbreakingPrefixes()
  const fallback = np.getWordsAsArray('this-lang-does-not-exist')
  const en = np.getWordsAsArray('en')
  t.alike(fallback, en)
})

test('NonbreakingPrefixes: lang=null yields prefixes from every language', (t) => {
  const np = new NonbreakingPrefixes()
  const all = np.getWordsAsArray(null)
  // We have 38 supported languages; at minimum the all-langs set
  // should be substantially larger than just English.
  const en = np.getWordsAsArray('en')
  t.ok(all.length > en.length, `all-langs should yield more than just en (${all.length} vs ${en.length})`)
})

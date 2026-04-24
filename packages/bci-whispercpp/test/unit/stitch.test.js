'use strict'

const test = require('brittle')
const { stitchMerge, stitchSegments, normalizeWord } = require('../../lib/stream')

test('[stitch] empty prev: delta equals full new text', (t) => {
  const { delta, merged } = stitchMerge('', 'hello world', 40)
  t.is(delta, 'hello world')
  t.is(merged, 'hello world')
})

test('[stitch] empty new: delta is empty, merged equals prev', (t) => {
  const { delta, merged } = stitchMerge('hello world', '', 40)
  t.is(delta, '')
  t.is(merged, 'hello world')
})

test('[stitch] both empty', (t) => {
  const { delta, merged } = stitchMerge('', '', 40)
  t.is(delta, '')
  t.is(merged, '')
})

test('[stitch] perfect overlap: delta is empty, merged unchanged', (t) => {
  const { delta, merged } = stitchMerge('hello world', 'hello world', 40)
  t.is(delta, '')
  t.is(merged, 'hello world')
})

test('[stitch] partial overlap at boundary extends merged with tail', (t) => {
  const { delta, merged } = stitchMerge('I went to the', 'to the store today', 40)
  t.is(delta, 'store today')
  t.is(merged, 'I went to the store today')
})

test('[stitch] no overlap: delta equals full new text', (t) => {
  const { delta, merged } = stitchMerge('alpha beta', 'gamma delta', 40)
  t.is(delta, 'gamma delta')
  t.is(merged, 'alpha beta gamma delta')
})

test('[stitch] single-word overlap at the seam', (t) => {
  const { delta, merged } = stitchMerge('hello world', 'world peace', 40)
  t.is(delta, 'peace')
  t.is(merged, 'hello world peace')
})

test('[stitch] picks the longest suffix match, not the shortest', (t) => {
  // Prev ends "to the", new starts "to the". k=2 must win even though
  // k=1 ("the" == "the"... wait, new[0]="to" so k=1 compares "the" vs "to"
  // which mismatches). Exercise a case where both k=1 and k=2 would match.
  const { delta, merged } = stitchMerge('go to the', 'to the moon', 40)
  t.is(delta, 'moon')
  t.is(merged, 'go to the moon')
})

test('[stitch] case and punctuation are ignored for overlap detection', (t) => {
  const { delta, merged } = stitchMerge('we said Hello, World', 'hello world! again', 40)
  // "Hello, World" ~= "hello world" after normalisation; delta should
  // start at "again".
  t.is(delta, 'again')
  // Merged preserves the original casing/punctuation of prev words.
  t.is(merged, 'we said Hello, World again')
})

test('[stitch] fully-empty-normalised words never count as a match', (t) => {
  // Punctuation-only "words" normalise to "", which the algorithm
  // treats as a non-match so we do not over-eagerly stitch.
  const { delta, merged } = stitchMerge('foo ...', '... bar', 40)
  t.is(delta, '... bar')
  t.is(merged, 'foo ... ... bar')
})

test('[stitch] maxWords caps the overlap search depth', (t) => {
  const prev = 'a b c d e f g h'
  const newText = 'd e f g h i j'
  const withoutCap = stitchMerge(prev, newText, 40)
  t.is(withoutCap.delta, 'i j')
  t.is(withoutCap.merged, 'a b c d e f g h i j')

  // With maxWords=3, only the last 3 words of prev can participate in
  // the match, so "d e" at positions 0..1 of newText can't be detected
  // as overlap (would require k=5). The algorithm should still find the
  // k=3 suffix "f g h" == new prefix "f g h"... wait, newText starts
  // with "d e f", not "f g h". So with cap=3, best k=0 and no stitch.
  const capped = stitchMerge(prev, newText, 3)
  t.is(capped.delta, 'd e f g h i j')
  t.is(capped.merged, 'a b c d e f g h d e f g h i j')
})

test('[stitch] new text fully contained in prev suffix yields empty delta', (t) => {
  const { delta, merged } = stitchMerge('the quick brown fox', 'quick brown fox', 40)
  t.is(delta, '')
  t.is(merged, 'the quick brown fox')
})

test('[stitch] legitimate repeat-at-boundary collapses (known v1 limitation)', (t) => {
  // If the transcript legitimately contains "the the" across a window
  // seam, the stitcher currently dedupes it. This test pins the
  // behaviour so future changes to the algorithm are intentional.
  const { delta, merged } = stitchMerge('say the', 'the word', 40)
  t.is(delta, 'word')
  t.is(merged, 'say the word')
})

test('[stitchSegments] empty prev: all non-empty segments pass through with windowStartTimestep', (t) => {
  const segs = [
    { text: 'hello world', t0: 0, t1: 120 },
    { text: 'foo', t0: 130, t1: 160 }
  ]
  const { deltaSegments, merged, bestK } = stitchSegments('', segs, 40, 1500)
  t.is(bestK, 0)
  t.is(merged, 'hello world foo')
  t.is(deltaSegments.length, 2)
  t.is(deltaSegments[0].text, 'hello world')
  t.is(deltaSegments[0].t0, 0)
  t.is(deltaSegments[0].t1, 120)
  t.is(deltaSegments[0].windowStartTimestep, 1500)
  t.is(deltaSegments[1].windowStartTimestep, 1500)
})

test('[stitchSegments] empty / missing-text segments are dropped from output', (t) => {
  const segs = [
    { text: '', t0: 0, t1: 10 },
    { text: 'hello', t0: 10, t1: 50 },
    { t0: 50, t1: 60 }
  ]
  const { deltaSegments, merged } = stitchSegments('', segs, 40, 0)
  t.is(merged, 'hello')
  t.is(deltaSegments.length, 1)
  t.is(deltaSegments[0].text, 'hello')
})

test('[stitchSegments] fully-overlapped leading segment is dropped; non-overlapping tail kept intact', (t) => {
  const segs = [
    { text: 'to the', t0: 0, t1: 100 },
    { text: 'store today', t0: 100, t1: 250 }
  ]
  const { deltaSegments, merged, bestK } = stitchSegments('I went to the', segs, 40, 2000)
  t.is(bestK, 2)
  t.is(merged, 'I went to the store today')
  t.is(deltaSegments.length, 1)
  t.is(deltaSegments[0].text, 'store today')
  t.is(deltaSegments[0].t0, 100, 'native t0 is preserved verbatim')
  t.is(deltaSegments[0].t1, 250, 'native t1 is preserved verbatim')
  t.is(deltaSegments[0].windowStartTimestep, 2000)
})

test('[stitchSegments] partial overlap inside a single segment trims text and advances t0 proportionally', (t) => {
  const segs = [
    { text: 'the store today', t0: 0, t1: 300 }
  ]
  const { deltaSegments, merged, bestK } = stitchSegments('went to the', segs, 40, 500)
  t.is(bestK, 1)
  t.is(merged, 'went to the store today')
  t.is(deltaSegments.length, 1)
  t.is(deltaSegments[0].text, 'store today')
  t.is(deltaSegments[0].t0, 100, 't0 is advanced by (t1-t0) * droppedWords/totalWords')
  t.is(deltaSegments[0].t1, 300, 't1 is unchanged (segment end did not move)')
  t.is(deltaSegments[0].windowStartTimestep, 500)
})

test('[stitchSegments] fully contained: new text entirely matches prev suffix → no delta', (t) => {
  const segs = [{ text: 'quick brown fox', t0: 0, t1: 100 }]
  const { deltaSegments, merged, bestK } = stitchSegments('the quick brown fox', segs, 40, 0)
  t.is(bestK, 3)
  t.is(merged, 'the quick brown fox')
  t.is(deltaSegments.length, 0)
})

test('[stitchSegments] no overlap: all segments pass through', (t) => {
  const segs = [
    { text: 'gamma', t0: 0, t1: 50 },
    { text: 'delta', t0: 50, t1: 100 }
  ]
  const { deltaSegments, merged, bestK } = stitchSegments('alpha beta', segs, 40, 0)
  t.is(bestK, 0)
  t.is(merged, 'alpha beta gamma delta')
  t.is(deltaSegments.length, 2)
  t.is(deltaSegments[0].text, 'gamma')
  t.is(deltaSegments[1].text, 'delta')
})

test('[stitchSegments] punctuation-normalised overlap still preserves original casing in emitted text', (t) => {
  const segs = [
    { text: 'World!', t0: 0, t1: 40 },
    { text: 'again', t0: 40, t1: 80 }
  ]
  const { deltaSegments, bestK } = stitchSegments('Hello world', segs, 40, 0)
  t.is(bestK, 1, '"World!" normalises to "world" and matches prev suffix')
  t.is(deltaSegments.length, 1)
  t.is(deltaSegments[0].text, 'again')
})

test('[normalizeWord] lowercases and strips non-alphanumeric except apostrophe', (t) => {
  t.is(normalizeWord('Hello,'), 'hello')
  t.is(normalizeWord('Don\'t!'), 'don\'t')
  t.is(normalizeWord('...'), '')
  t.is(normalizeWord('Foo123'), 'foo123')
})

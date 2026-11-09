import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTemplate, expandTemplate, splitArgs } from '../../dist/product/templates.js'

test('parseTemplate reads frontmatter and body', () => {
  const t = parseTemplate(
    'review',
    '---\ndescription: "Review a file"\nargument-hint: <file> [focus]\n---\nReview $1 for $2\n'
  )
  assert.deepEqual(t, {
    name: 'review',
    description: 'Review a file',
    argumentHint: '<file> [focus]',
    body: 'Review $1 for $2\n'
  })
})

test('parseTemplate without frontmatter uses the first line as description', () => {
  const t = parseTemplate('plain', '\nExplain this code\nmore\n')
  assert.equal(t.description, 'Explain this code')
  assert.equal(t.argumentHint, '')
  assert.equal(t.body, '\nExplain this code\nmore\n')
})

test('splitArgs honours quotes and escapes', () => {
  assert.deepEqual(splitArgs(`a "b c" 'd "e"' f\\ g ""`), ['a', 'b c', 'd "e"', 'f g', ''])
  assert.deepEqual(splitArgs('   '), [])
})

test('expandTemplate substitutes positionals and all-args forms', () => {
  const args = 'one "two words" three four'
  assert.equal(expandTemplate('$1|$2|$3|$9', args), 'one|two words|three|')
  assert.equal(
    expandTemplate('$@ / $ARGUMENTS', args),
    'one two words three four / one two words three four'
  )
  assert.equal(expandTemplate('${@:2}', args), 'two words three four')
  assert.equal(expandTemplate('${@:2:2}', args), 'two words three')
  assert.equal(expandTemplate('${1:-x} ${5:-fallback value}', args), 'one fallback value')
  assert.equal(expandTemplate('${@:-none}', ''), 'none')
})

test('expandTemplate does not re-expand substituted text', () => {
  assert.equal(expandTemplate('$1 $2', "'$2' b"), '$2 b')
})

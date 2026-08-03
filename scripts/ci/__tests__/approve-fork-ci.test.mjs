import test from 'node:test'
import assert from 'node:assert/strict'

import { parseArgs, checkApprovalPin } from '../approve-fork-ci.mjs'

const HEAD = 'c969e50dde20ea728db8ed6c1f1162fdc7a9dd73'

test('parseArgs: pr number, sha pin and confirmation flag', () => {
  assert.deepEqual(parseArgs(['3510']), { pr: '3510', sha: null, confirmed: false })
  assert.deepEqual(parseArgs(['3510', '--sha', HEAD, '--yes']), {
    pr: '3510',
    sha: HEAD,
    confirmed: true,
  })
  assert.deepEqual(parseArgs(['--yes', '--sha', HEAD, '3510']), {
    pr: '3510',
    sha: HEAD,
    confirmed: true,
  })
})

test('parseArgs: rejects unknown arguments rather than ignoring them', () => {
  assert.throws(() => parseArgs(['3510', '--force']), /unknown argument: --force/)
})

test('a dry run needs no pin', () => {
  assert.equal(
    checkApprovalPin({ requestedSha: null, currentSha: HEAD, confirmed: false }),
    null,
  )
})

test('approving requires naming the reviewed commit', () => {
  const error = checkApprovalPin({
    requestedSha: null,
    currentSha: HEAD,
    confirmed: true,
  })
  assert.match(error, /--yes requires --sha/)
})

test('approving a commit that moved since review is refused', () => {
  // The head SHA is resolved at invocation time. Without this check, a push
  // landing between review and approval would be approved sight-unseen.
  const error = checkApprovalPin({
    requestedSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    currentSha: HEAD,
    confirmed: true,
  })
  assert.match(error, /does not match the current head/)
})

test('approving the reviewed commit is allowed, including by short sha', () => {
  assert.equal(
    checkApprovalPin({ requestedSha: HEAD, currentSha: HEAD, confirmed: true }),
    null,
  )
  assert.equal(
    checkApprovalPin({ requestedSha: 'c969e50dd', currentSha: HEAD, confirmed: true }),
    null,
  )
})

test('a short sha must be a prefix, not merely a substring', () => {
  const error = checkApprovalPin({
    requestedSha: '969e50dd',
    currentSha: HEAD,
    confirmed: true,
  })
  assert.match(error, /does not match the current head/)
})

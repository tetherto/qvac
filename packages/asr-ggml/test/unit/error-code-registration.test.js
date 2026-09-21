'use strict'

// @qvac/error's duplicate guard is keyed on the OWNING PACKAGE NAME, so the
// merge's rename is by itself enough to collide: 6001-6018 belonged to
// @qvac/transcription-whispercpp and 24001-24019 to
// @qvac/transcription-parakeet. A process that loads a pre-merge ASR package
// and @qvac/asr-ggml against one hoisted @qvac/error would otherwise throw
// ERROR_CODE_ALREADY_EXISTS at module scope — i.e. require('@qvac/asr-ggml')
// would crash. registerCodes() tolerates exactly that case.

const test = require('brittle')
const QvacError = require('@qvac/error')
const ASRGgml = require('../../index.js')
const { registerCodes } = require('../../lib/error.js')

const process = require('bare-process')
global.process = process

// A private numeric range, so the suite never perturbs the real tables.
const OWNED_BY_OTHER = 991001
const UNOWNED = 991002

test('the package registers every historical code from both parents', (t) => {
  t.ok(QvacError.isCodeRegistered(6001), 'whisper FAILED_TO_LOAD_WEIGHTS stays resolvable')
  t.ok(QvacError.isCodeRegistered(6018), 'whisper VAD_MODEL_NOT_FOUND stays resolvable')
  t.ok(QvacError.isCodeRegistered(24009), 'parakeet MODEL_NOT_FOUND stays resolvable')
  t.ok(QvacError.isCodeRegistered(24019), 'parakeet JOB_CANCELLED stays resolvable')
  t.is(
    new ASRGgml.Error({ code: ASRGgml.ERR_CODES.INVALID_ENGINE }).code,
    6021,
    'and the new asr-ggml codes render through the unified error class'
  )
})

test('registerCodes tolerates codes already owned by another package', (t) => {
  QvacError.addCodes(
    { [OWNED_BY_OTHER]: { name: 'PRE_MERGE_CODE', message: () => 'pre-merge text' } },
    { name: '@qvac/transcription-whispercpp-fixture', version: '0.12.1' }
  )

  // A plain addCodes for the same number under a different owner blows up...
  t.exception(
    () =>
      QvacError.addCodes(
        {
          [OWNED_BY_OTHER]: { name: 'MERGED_CODE', message: () => 'merged text' },
          [UNOWNED]: { name: 'NEW_CODE', message: () => 'new text' }
        },
        { name: '@qvac/asr-ggml-fixture-a', version: '0.1.0' }
      ),
    'plain addCodes throws ERROR_CODE_ALREADY_EXISTS on a renamed owner'
  )

  // ...while registerCodes absorbs it and still claims what nobody owns.
  registerCodes(
    {
      [OWNED_BY_OTHER]: { name: 'MERGED_CODE', message: () => 'merged text' },
      [UNOWNED]: { name: 'NEW_CODE', message: () => 'new text' }
    },
    { name: '@qvac/asr-ggml-fixture-b', version: '0.1.0' }
  )

  t.ok(QvacError.isCodeRegistered(OWNED_BY_OTHER), 'the contested code stays resolvable')
  t.ok(QvacError.isCodeRegistered(UNOWNED), 'the uncontested code is registered')
  t.is(
    new QvacError.QvacErrorBase({ code: UNOWNED }).code,
    UNOWNED,
    'and it renders as a real error'
  )
})

test('registerCodes rethrows failures that are not collisions', (t) => {
  t.exception(
    () =>
      registerCodes(
        { 991003: { name: 'BAD' } },
        { name: '@qvac/asr-ggml-fixture-c', version: '0.1.0' }
      ),
    'a definition without a message is still an error'
  )
})

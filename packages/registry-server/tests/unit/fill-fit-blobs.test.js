'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { exitCodeFor, EXIT_OK, EXIT_RECORDS_SKIPPED } = require('../../scripts/fill-fit-blobs')

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'fill-fit-blobs-registry-server.yml'
)
const WORKFLOW_SKIPPED_EXIT = /RECORDS_SKIPPED_EXIT: "(\d+)"/

const SKIP = {
  path: 'qvac_models_compiled/ggml/indictrans2/model.bin',
  reason: 'no metadata region'
}

function reportWith(skipped) {
  return { selected: 2, filled: 2 - skipped.length, skipped }
}

test('a fill that wrote every selected record exits cleanly', (t) => {
  t.is(exitCodeFor({ dryRun: false }, reportWith([])), EXIT_OK)
})

test('a fill that skipped a selected record exits with the skipped code', (t) => {
  t.is(exitCodeFor({ dryRun: false }, reportWith([SKIP])), EXIT_RECORDS_SKIPPED)
})

test('a dry run never fails on skipped records', (t) => {
  t.is(exitCodeFor({ dryRun: true }, reportWith([SKIP])), EXIT_OK)
})

test('the workflow reads the same exit code as skipped records', (t) => {
  const match = fs.readFileSync(WORKFLOW_PATH, 'utf8').match(WORKFLOW_SKIPPED_EXIT)
  t.ok(match, 'the workflow declares RECORDS_SKIPPED_EXIT')
  t.is(Number(match[1]), EXIT_RECORDS_SKIPPED)
})

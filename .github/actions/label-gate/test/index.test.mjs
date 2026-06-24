// Tests for the entrypoint's input plumbing. Pins the env-var-name
// resolution against the GitHub Actions runner's actual contract,
// which is what failed live in the QVAC-18612 canary on 2026-05-11
// (run id 25672483584): the runner exposes `github-token` as
// INPUT_GITHUB-TOKEN (hyphen preserved); an earlier impl looked up
// INPUT_GITHUB_TOKEN (hyphen-to-underscore) and silently lost the
// token, hard-failing every PR-event run.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getInput } from '../src/index.mjs';

test('getInput: simple uppercase name (no transform)', () => {
  const env = { INPUT_LABEL: 'verified' };
  assert.equal(getInput('label', { env }), 'verified');
});

test('getInput: hyphenated input -> hyphen PRESERVED in env-var name', () => {
  // This is the QVAC-18612 regression: runner sets INPUT_GITHUB-TOKEN,
  // not INPUT_GITHUB_TOKEN. getInput must match what the runner sets.
  const env = { 'INPUT_GITHUB-TOKEN': 'pat_xyz' };
  assert.equal(getInput('github-token', { env }), 'pat_xyz');
});

test('getInput: hyphen-replaced lookup must NOT find the value (lock the contract)', () => {
  // Belt-and-braces: assert the OPPOSITE form is silently empty so we
  // notice if anyone "helpfully" reintroduces the hyphen-to-underscore
  // substitution.
  const env = { INPUT_GITHUB_TOKEN: 'wrong-key' };
  assert.equal(getInput('github-token', { env }), '');
});

test('getInput: spaces are replaced with underscores (per @actions/core)', () => {
  const env = { INPUT_MY_INPUT: 'value' };
  assert.equal(getInput('my input', { env }), 'value');
});

test('getInput: missing optional input -> empty string', () => {
  assert.equal(getInput('label', { env: {} }), '');
});

test('getInput: missing required input -> throws with the original name', () => {
  assert.throws(
    () => getInput('github-token', { required: true, env: {} }),
    /required input 'github-token' is missing/
  );
});

test('getInput: empty/whitespace value treated as missing for required', () => {
  assert.throws(
    () => getInput('github-token', {
      required: true,
      env: { 'INPUT_GITHUB-TOKEN': '   ' },
    }),
    /required input 'github-token' is missing/
  );
});

test('getInput: trims surrounding whitespace from supplied value', () => {
  const env = { 'INPUT_GITHUB-TOKEN': '  pat_xyz  ' };
  assert.equal(getInput('github-token', { env }), 'pat_xyz');
});

test('getInput: defaults env to process.env when not supplied', () => {
  const original = process.env.INPUT_LABEL;
  process.env.INPUT_LABEL = 'from-process-env';
  try {
    assert.equal(getInput('label'), 'from-process-env');
  } finally {
    if (original === undefined) delete process.env.INPUT_LABEL;
    else process.env.INPUT_LABEL = original;
  }
});

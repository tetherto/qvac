import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkSpeechAddons,
  findSpeechAddons,
  parseArgs,
  summarizeSpeechAddons,
} from './check-speech-ggml-builds.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-ggml-builds-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(root, manifest) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
}

function speechAddon(name, version, ggmlSpeech) {
  return ggmlSpeech === null
    ? { name, version }
    : { name, version, qvac: { 'ggml-speech': ggmlSpeech } };
}

test('finds hoisted and nested speech addons with their recorded builds', (t) => {
  const modules = path.join(tempDir(t), 'node_modules');
  writePackage(path.join(modules, '@qvac/tts-ggml'), speechAddon('@qvac/tts-ggml', '0.12.0', '2026-10-07#1'));
  writePackage(
    path.join(modules, '@qvac/tts-ggml/node_modules/@qvac/asr-ggml'),
    speechAddon('@qvac/asr-ggml', '0.3.3', null),
  );
  writePackage(path.join(modules, '@qvac/llm-llamacpp'), { name: '@qvac/llm-llamacpp', version: '0.58.0' });
  writePackage(path.join(modules, 'bare-fs'), { name: 'bare-fs', version: '4.7.1' });

  const addons = findSpeechAddons(modules).sort((a, b) => a.id.localeCompare(b.id));

  assert.deepEqual(addons, [
    { id: '@qvac/asr-ggml@0.3.3', ggmlSpeech: null },
    { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' },
  ]);
});

test('finds nothing in a missing node_modules', (t) => {
  assert.deepEqual(findSpeechAddons(path.join(tempDir(t), 'node_modules')), []);
});

test('accepts speech addons that record one build', () => {
  const addons = [
    { id: '@qvac/asr-ggml@0.9.0', ggmlSpeech: '2026-10-07#1' },
    { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' },
  ];
  assert.deepEqual(checkSpeechAddons(addons), { errors: [], warnings: [] });
  assert.equal(
    summarizeSpeechAddons(addons),
    'ggml-speech: 2026-10-07#1 (@qvac/asr-ggml@0.9.0, @qvac/tts-ggml@0.12.0)',
  );
});

test('rejects speech addons that record different builds', () => {
  const addons = [
    { id: '@qvac/asr-ggml@0.9.0', ggmlSpeech: '2026-08-07' },
    { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' },
  ];
  assert.deepEqual(checkSpeechAddons(addons).errors, [
    'speech addons built from 2 ggml-speech versions: ' +
      '2026-08-07 (@qvac/asr-ggml@0.9.0); 2026-10-07#1 (@qvac/tts-ggml@0.12.0)',
  ]);
});

test('warns about an unrecorded speech addon only next to another one', () => {
  const unrecorded = { id: '@qvac/asr-ggml@0.3.3', ggmlSpeech: null };
  const recorded = { id: '@qvac/tts-ggml@0.12.0', ggmlSpeech: '2026-10-07#1' };
  assert.deepEqual(checkSpeechAddons([recorded, unrecorded]), {
    errors: [],
    warnings: ['@qvac/asr-ggml@0.3.3 does not record the ggml-speech build it ships, so it cannot be checked'],
  });
  assert.deepEqual(checkSpeechAddons([unrecorded]), { errors: [], warnings: [] });
  assert.equal(
    summarizeSpeechAddons([recorded, unrecorded]),
    'ggml-speech: 2026-10-07#1 (@qvac/tts-ggml@0.12.0); not recorded (@qvac/asr-ggml@0.3.3)',
  );
  assert.equal(summarizeSpeechAddons([]), 'ggml-speech: no speech addons installed');
});

test('parses --modules-dir', () => {
  assert.deepEqual(parseArgs([]), { modulesDir: 'node_modules' });
  assert.deepEqual(parseArgs(['--modules-dir', 'app/node_modules']), { modulesDir: 'app/node_modules' });
  assert.throws(() => parseArgs(['--platform']), /unknown argument --platform/);
});

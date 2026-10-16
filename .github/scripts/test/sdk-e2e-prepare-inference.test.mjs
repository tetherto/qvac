import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const prepareScript = fileURLToPath(
  new URL('../../actions/sdk-e2e-prepare-inference/prepare.mjs', import.meta.url)
)

test(
  'branch inference preparation succeeds on an npm-only runner',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sdk-inference-npm-'))
    try {
      const bin = path.join(root, 'bin')
      const sdk = path.join(root, 'sdk')
      const inference = path.join(root, 'inference')
      for (const dir of [bin, sdk, inference]) mkdirSync(dir)
      writeFileSync(
        path.join(sdk, 'package.json'),
        JSON.stringify({ dependencies: { '@qvac/inference': '^0.21.1' } })
      )
      writeFileSync(
        path.join(inference, 'package.json'),
        JSON.stringify({ name: '@qvac/inference', version: '0.21.1' })
      )
      const calls = path.join(root, 'calls.jsonl')
      const npm = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'pack') {
  const dir = args[args.indexOf('--pack-destination') + 1];
  const filename = 'qvac-inference-0.21.1.tgz';
  fs.writeFileSync(path.join(dir, filename), 'candidate');
  process.stdout.write(JSON.stringify([{ filename }]));
}
`
      writeFileSync(path.join(bin, 'npm'), npm, { mode: 0o755 })
      const output = path.join(root, 'outputs')
      const result = spawnSync(process.execPath, [prepareScript, 'resolve'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin,
          NPM_CALLS: calls,
          INFERENCE_SOURCE: 'branch',
          PROJECT_DIRECTORY: sdk,
          INFERENCE_DIRECTORY: inference,
          ARTIFACT_DIRECTORY: path.join(root, 'artifacts'),
          CHECKOUT_SHA: 'reviewed-head',
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: path.join(root, 'summary')
        }
      })
      assert.equal(result.status, 0, result.stderr)
      const invoked = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.deepEqual(invoked.slice(0, 2), [
        ['install', '--ignore-scripts'],
        ['run', 'build']
      ])
      assert.match(
        readFileSync(output, 'utf8'),
        /provenance=branch:reviewed-head:@qvac\/inference@0\.21\.1/
      )
      assert.match(readFileSync(output, 'utf8'), /artifact-path=.*qvac-inference-0\.21\.1\.tgz/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

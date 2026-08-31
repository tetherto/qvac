// Guards the condition on every on-merge `publish-gpr` job.
//
// QVAC-24365: `publish-gpr` in on-merge-ocr-ggml.yml and
// on-merge-translation-nmtcpp.yml was skipped on every non-release-* branch, so
// neither addon had ever published a GPR dev build and neither could be
// mobile-tested against branch-native code.
//
// The mechanism is GitHub's skip propagation, and it is invisible in the job's
// own condition. `publish-gpr` needs `build`; in those two workflows `build`
// additionally needs `release-merge-guard`, which is skipped off release-*.
// `build` survives that only because its own `if` opens with `!cancelled()`.
// Without the same opt-out on `publish-gpr`, the skip travels through `build`
// and the job never runs.
//
// The invariant is therefore conditional: a `publish-gpr` whose `build` can be
// skipped upstream MUST opt out with !cancelled()/always(), and — because that
// also disables the implicit "all needs succeeded" check — MUST then assert
// needs.build.result explicitly, or a failed build could publish.
//
// Parsed as text on purpose: the `policy-tests` job runs `node --test` with no
// npm install, so no YAML library is available. Same approach as
// ci-trust-policy.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function onMergeWorkflows() {
  const out = spawnSync('git', ['ls-files', '.github/workflows/on-merge-*.yml'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout
  return out.trim().split('\n').filter(Boolean)
}

// Text of one top-level job, from `  <name>:` to the next job at the same indent.
function jobBlock(source, jobName) {
  const start = source.indexOf(`\n  ${jobName}:`)
  if (start === -1) return null
  const rest = source.slice(start + 1)
  const next = rest.search(/\n {2}[A-Za-z_][A-Za-z0-9_-]*:/)
  return next === -1 ? rest : rest.slice(0, next)
}

// The `if:` value, flattened to one line. Handles both `if: >-` folded blocks
// and a single-line `if:`.
function condition(block) {
  if (!block) return ''
  const folded = block.match(/\n {4}if: *>-?\n([\s\S]*?)(?=\n {4}[A-Za-z_][A-Za-z0-9_-]*:|\n {4}#|$)/)
  if (folded) return folded[1].replace(/\s+/g, ' ').trim()
  const inline = block.match(/\n {4}if: *(.+)/)
  return inline ? inline[1].trim() : ''
}

const WORKFLOWS = onMergeWorkflows()

test('on-merge workflows were discovered', () => {
  assert.ok(WORKFLOWS.length >= 12, `found ${WORKFLOWS.length}`)
})

for (const relativePath of WORKFLOWS) {
  const slug = relativePath.replace(/.*on-merge-|\.yml$/g, '')
  const source = read(relativePath)
  const gpr = jobBlock(source, 'publish-gpr')
  if (!gpr) continue

  const build = jobBlock(source, 'build')
  // The real skippable dependency: release-merge-guard only runs on release-*.
  // Reached transitively, via publish-gpr -> build -> release-merge-guard.
  const buildCanBeSkipped = Boolean(build) && /needs:[\s\S]*?release-merge-guard/.test(build)

  test(`${slug}: publish-gpr survives a skipped upstream dependency`, () => {
    if (!buildCanBeSkipped) return

    const cond = condition(gpr)
    assert.ok(cond, 'publish-gpr has an if: condition')

    assert.match(
      cond,
      /!cancelled\(\)|always\(\)/,
      'publish-gpr depends on build, which depends on release-merge-guard and is ' +
        'therefore skippable off release-*. Without !cancelled() the skip ' +
        `propagates and publish-gpr silently never runs. Condition:\n  ${cond}`,
    )

    assert.match(
      cond,
      /needs\.build\.result\s*==\s*'success'/,
      'publish-gpr opts out with !cancelled()/always(), which also drops the ' +
        'implicit needs-succeeded check, so it must assert ' +
        `needs.build.result == 'success' explicitly or a failed build can ` +
        `publish. Condition:\n  ${cond}`,
    )
  })

  test(`${slug}: publish-gpr reads the GPR action's own output name`, () => {
    // .github/actions/publish-library-to-gpr emits gpr_published_version.
    // npm_published_version belongs to the separate npm publish action, so
    // reading it here yields a permanently empty output.
    if (!/published_version:/.test(gpr)) return
    assert.ok(
      !/published_version: \$\{\{ steps\.publish\.outputs\.npm_published_version \}\}/.test(gpr),
      'publish-gpr must read steps.publish.outputs.gpr_published_version; ' +
        "npm_published_version is the npm action's output and is always empty here.",
    )
  })
}

// The two addons this ticket was raised for, named explicitly so an edit that
// reintroduces the defect fails a test that mentions them.
for (const slug of ['ocr-ggml', 'translation-nmtcpp']) {
  test(`${slug}: publish-gpr can run off release-* (QVAC-24365 regression)`, () => {
    const cond = condition(jobBlock(read(`.github/workflows/on-merge-${slug}.yml`), 'publish-gpr'))
    assert.match(cond, /!cancelled\(\)/, `${slug} publish-gpr lost its !cancelled()`)
    assert.match(cond, /needs\.build\.result\s*==\s*'success'/)
    assert.match(cond, /publish_tmp\s*==\s*'true'/, 'tmp-* must remain a publishing branch')
  })

  // Fixing publish-gpr must not switch merge-time integration tests on: they
  // already run on the PR, and the PR's merge-guard consumes their result
  // before the merge is allowed.
  test(`${slug}: a GPR publish does not re-run integration tests on merge`, () => {
    const gate = jobBlock(read(`.github/workflows/on-merge-${slug}.yml`), 'post-build-gate')
    assert.ok(gate, 'post-build-gate exists')

    assert.match(
      gate,
      /needs\.publish-npm\.result \}\}" = "success"/,
      'the gate must still open for a real npm release',
    )
    assert.ok(
      !/needs\.publish-gpr\.result \}\}" = "success"/.test(gate),
      'a GPR dev publish must not open the integration-test gate — those tests ' +
        'already ran on the PR and merge-guard gated on them. Keying on ' +
        'publish-gpr silently adds a 6-leg GPU matrix to every main/tmp push.',
    )
  })
}

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
// The invariant is therefore conditional: a `publish-gpr` with a skippable
// dependency MUST opt out with !cancelled()/always(), and — because that also
// disables the implicit "all needs succeeded" check — MUST then assert that
// dependency's result explicitly, or a failed build could publish.
//
// Parsed as text on purpose: the `policy-tests` job runs `node --test` with no
// npm install, so no YAML library is available. Same approach as
// ci-trust-policy.test.mjs and publish-gate-policy.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

// readdirSync, not `git ls-files`: no spawn to fail, and an untracked new
// on-merge workflow is still covered when running locally. Matches
// publish-gate-policy.test.mjs.
function onMergeWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /^on-merge-.*\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`)
}

// Text of one top-level job, from `  <name>:` to the next job at the same indent.
function jobBlock(source, jobName) {
  const start = source.indexOf(`\n  ${jobName}:`)
  if (start === -1) return null
  const rest = source.slice(start + 1)
  const next = rest.search(/\n {2}[A-Za-z_][A-Za-z0-9_-]*:/)
  return next === -1 ? rest : rest.slice(0, next)
}

// The `if:` value, flattened to one line. Accepts BOTH block-scalar styles:
// `>`/`>-`/`>+` and `|`/`|-`/`|+`. Handling only `>-` made a `|-` job fall
// through to the inline branch and return the scalar indicator itself ("|-")
// as the condition — on-merge-decoder-audio.yml uses `if: |-` today.
function condition(jobText) {
  if (!jobText) return ''
  const folded = jobText.match(/^ {4}if:[ \t]*[|>][-+]?[ \t]*\n((?: {6}.*\n|\n)*)/m)
  if (folded) {
    return folded[1].split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
  }
  const inline = jobText.match(/^ {4}if:[ \t]*(.+)$/m)
  return inline ? inline[1].trim() : ''
}

// Job names listed under this job's `needs:`. All THREE legal YAML spellings
// must be handled, because a parse miss here reports "no dependencies", which
// makes the guard walk return false and turns the miss into a silent pass:
//
//   needs: [a, b]     inline array
//   needs:\n  - a     block sequence  (may be interleaved with comments)
//   needs: a          plain scalar    — on-merge-vla.yml and
//                                       on-merge-classification-ggml.yml use it
//
// Returns null (not []) when a `needs:` key exists but nothing parses out, so
// callers can fail loudly instead of treating a parser failure as a clean bill
// of health.
function needsOf(jobText) {
  if (!jobText) return []
  if (!/^ {4}needs:/m.test(jobText)) return []

  const inline = jobText.match(/^ {4}needs:[ \t]*\[([^\]]*)\]/m)
  if (inline) {
    const names = inline[1].split(',').map((s) => s.trim()).filter(Boolean)
    return names.length ? names : null
  }

  // Absorb comment and blank lines inside the sequence, then keep only entries.
  // Requiring consecutive `      - ` lines silently truncated the list at the
  // first interleaved comment — dropping exactly the release-merge-guard entry
  // this test exists to find.
  const block = jobText.match(/^ {4}needs:[ \t]*\n((?: {6}(?:- .*|#.*)\n|[ \t]*\n)*)/m)
  if (block && /- /.test(block[1])) {
    const names = block[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- */, '').trim())
      .filter(Boolean)
    return names.length ? names : null
  }

  const scalar = jobText.match(/^ {4}needs:[ \t]*([A-Za-z_][A-Za-z0-9_-]*)[ \t]*$/m)
  if (scalar) return [scalar[1]]

  return null
}

const WORKFLOWS = onMergeWorkflows()

test('on-merge workflows were discovered', () => {
  assert.ok(WORKFLOWS.length >= 12, `found ${WORKFLOWS.length}`)
})

for (const relativePath of WORKFLOWS) {
  const slug = relativePath.replace(/.*on-merge-|\.ya?ml$/g, '')
  const source = read(relativePath)
  const gpr = jobBlock(source, 'publish-gpr')
  if (!gpr) continue

  // Which dependency chain can leak a skip into publish-gpr?
  //
  // NOT simply "the dependency has an if:" — every `build` job is gated on the
  // publish flags, and when those are false the build is legitimately skipped
  // and publish-gpr should be skipped too. That is normal operation, not a bug.
  //
  // The bug is a dependency that is skipped WHILE publish-gpr's own condition is
  // still true. The concrete case is `release-merge-guard`, gated on
  // `startsWith(github.ref_name, 'release-')`: on every other branch it is
  // skipped, and GitHub propagates that skip transitively through whatever
  // depends on it — even though that intermediate job itself succeeded, because
  // it carries its own !cancelled().
  //
  // So: look for release-merge-guard in publish-gpr's TRANSITIVE needs, and
  // report which direct dependency carries it. Not hardcoded to the name
  // `build` — classification-ggml calls the equivalent job `prebuild`.
  const GUARD = 'release-merge-guard'
  const parseMisses = []

  function depsOrRecord(jobName, jobText) {
    const deps = needsOf(jobText)
    if (deps === null) {
      parseMisses.push(jobName)
      return []
    }
    return deps
  }

  function reachesGuard(jobName, seen = new Set()) {
    if (seen.has(jobName)) return false
    seen.add(jobName)
    const deps = depsOrRecord(jobName, jobBlock(source, jobName))
    if (deps.includes(GUARD)) return true
    return deps.some((d) => reachesGuard(d, seen))
  }

  const gprDeps = depsOrRecord('publish-gpr', gpr)
  const skippableDeps = gprDeps.filter((dep) => dep === GUARD || reachesGuard(dep))

  test(`${slug}: publish-gpr survives a skipped upstream dependency`, () => {
    // A `needs:` key that yields nothing is a parser failure, not proof of
    // safety. Fail here rather than returning early, otherwise an unsupported
    // spelling silently switches this guard off for the whole workflow.
    assert.deepEqual(
      parseMisses,
      [],
      `could not parse the needs: list of ${parseMisses.join(', ')} in ` +
        `${relativePath}. Treating that as "no dependencies" would let this ` +
        'guard pass on a workflow carrying the defect.',
    )

    if (skippableDeps.length === 0) return

    const cond = condition(gpr)
    assert.ok(cond, 'publish-gpr has an if: condition')

    assert.match(
      cond,
      /!cancelled\(\)|always\(\)/,
      `publish-gpr depends on ${skippableDeps.join(', ')}, which can be skipped. ` +
        'Without !cancelled() the skip propagates and publish-gpr silently never ' +
        `runs. Condition:\n  ${cond}`,
    )

    // The opt-out also drops the implicit needs-succeeded check, so the job must
    // assert the result of at least one skippable dependency itself, or a failed
    // build could publish.
    const assertsADep = skippableDeps.some((dep) =>
      new RegExp(`needs\\.${dep}\\.result`).test(cond),
    )
    assert.ok(
      assertsADep,
      'publish-gpr opts out with !cancelled()/always(), which also drops the ' +
        'implicit needs-succeeded check, so it must assert the result of one of ' +
        `its skippable dependencies (${skippableDeps.join(', ')}) explicitly or a ` +
        `failed build can publish. Condition:\n  ${cond}`,
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
  //
  // Matched on co-occurrence rather than one exact spelling: the point is that
  // publish-gpr's result must not gate this step at all, however it is written
  // (==, single quotes, or moved into `env:`).
  test(`${slug}: a GPR publish does not re-run integration tests on merge`, () => {
    const gate = jobBlock(read(`.github/workflows/on-merge-${slug}.yml`), 'post-build-gate')
    assert.ok(gate, 'post-build-gate exists')

    // Only the shell `if` test decides; an `echo` naming publish-gpr is
    // deliberate diagnostics, so the assertion must look at the gating
    // expression rather than at any mention in the step.
    const gatingLines = gate
      .split('\n')
      .filter((l) => /^\s*(if|elif)\s+\[/.test(l) || /^\s*\[/.test(l))
      .join(' ')

    assert.ok(gatingLines, 'the gate has a shell condition')
    assert.match(
      gatingLines,
      /needs\.publish-npm\.result/,
      'the gate must still open for a real npm release',
    )
    assert.ok(
      !/needs\.publish-gpr\.result/.test(gatingLines),
      'a GPR dev publish must not gate the integration-test decision — those ' +
        'tests already ran on the PR and merge-guard gated on them. Keying on ' +
        `publish-gpr silently adds a 6-leg GPU matrix to every main/tmp push. ` +
        `Gating expression:\n  ${gatingLines}`,
    )
  })
}

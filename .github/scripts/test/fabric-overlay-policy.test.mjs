// Guards the @qvac/fabric overlay wiring across every on-PR lane of every
// fabric consumer.
//
// QVAC-24913: cpp-lint.yaml was the one lane with no overlay. prebuilds,
// cpp-tests and integration-tests all downloaded the PR-built fabric prebuilds
// and copied them over node_modules/@qvac/fabric before configuring; cpp-lint
// did a plain `npm install` and ran clang-tidy against whatever the registry
// served. So on a fabric bump the addon's translation units were parsed against
// the RELEASED headers, and every signature the PR had already moved past was
// reported as a clang-tidy error. Surfaced by the fabric 10549.0.0 rollout
// (PR #4154), where model-fit's 9-argument common_fit_params call met the
// published 8-argument declaration.
//
// The invariant has two halves, and the second is the one that bites:
//
//   1. If a reusable workflow accepts `fabric-overlay-artifact`, then every
//      fabric-consumer job that calls it must pass it. A lane that compiles the
//      addon against fabric and skips the overlay is the bug above.
//
//   2. That job must also list BOTH `detect-fabric-stack` and
//      `resolve-fabric-prebuilds` under `needs:`. The value is
//      `needs.detect-fabric-stack.outputs.needs_fabric_artifact == 'true' && ...`,
//      and GitHub resolves `needs.<job>` to empty for a job that is not a
//      dependency — no error, no warning. Pass the expression without the
//      dependency and the overlay silently never runs, which looks exactly like
//      the bug this test exists to prevent while appearing wired in review.
//
// SCOPE — this guards the npm prebuilds overlay, which is not the only way a
// package consumes fabric. There are two distinct consumption paths:
//
//   - The npm prebuilds tree. `@qvac/fabric` in package.json ships
//     node_modules/@qvac/fabric/prebuilds, and qvac-addon.cmake points
//     qvac-fabric_DIR at share/qvac-fabric/cmake inside it. This tree is what
//     overlay-local-fabric rewrites, and an unpublished PR build of it can be
//     handed to a consumer as an artifact — hence the whole overlay mechanism,
//     and hence this test.
//   - The vcpkg port. llm-llamacpp and embed-llamacpp declare qvac-fabric in
//     vcpkg.json with a `version>=` pin and take it from the registry. They DO
//     link against fabric — the earlier claim that they do not was simply
//     wrong — but a port revision only reaches a build once it is published to
//     qvac-registry-vcpkg, so there is no PR-built tree to overlay and nothing
//     for this test to assert. Their lockstep is enforced separately by
//     verify-fabric-lockstep / .github/actions/verify-qvac-fabric-lockstep.
//
// So `fabricConsumerPackages()` below deliberately reads package.json only. It
// is not a general "who uses fabric" query, and must not be extended into one:
// making it read vcpkg.json would demand a detect-fabric-stack job from
// llm-llamacpp and embed-llamacpp, which correctly do not have one.
//
// A workflow counts as an overlay consumer when it has BOTH a
// `detect-fabric-stack` and a `resolve-fabric-prebuilds` job. Two exemptions
// fall out of that, and only the first is by absence:
//
//   - diffusion-cpp, asr-ggml, tts-ggml, audiogen-ggml, bci-whispercpp, and the
//     two vcpkg consumers above, all call the same shared cpp-lint.yaml but
//     never receive a fabric prebuilds artifact, so they have neither job.
//   - on-pr-fabric.yml is the PRODUCER. It detects the stack to drive its own
//     prebuild and smoke jobs, but never resolves an artifact because it is the
//     one building it; overlaying fabric onto its own source tree is
//     meaningless. Asserted explicitly below rather than left to luck.
//
// Parsed as text on purpose: the trust-policy job runs `node --test` with no
// npm install, so no YAML library is available. Same approach (and the same
// jobBlock/needsOf helpers) as publish-gpr-skip-policy.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const WORKFLOW_DIR = join(root, '.github/workflows')
const PACKAGE_DIR = join(root, 'packages')

const OVERLAY_INPUT = 'fabric-overlay-artifact'
const DETECT_JOB = 'detect-fabric-stack'
const RESOLVE_JOB = 'resolve-fabric-prebuilds'

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function onPrWorkflows() {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => /^on-pr-.*\.ya?ml$/.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`)
}

// Text of one top-level job, from `  <name>:` to the next job at the same
// indent. Copied from publish-gpr-skip-policy.test.mjs.
function jobBlock(source, jobName) {
  const start = source.indexOf(`\n  ${jobName}:`)
  if (start === -1) return null
  const rest = source.slice(start + 1)
  const next = rest.search(/\n {2}[A-Za-z_][A-Za-z0-9_-]*:/)
  return next === -1 ? rest : rest.slice(0, next)
}

// Every top-level job name, in file order.
function jobNames(source) {
  const jobsAt = source.search(/^jobs:/m)
  if (jobsAt === -1) return []
  const body = source.slice(jobsAt)
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_-]*):/gm)].map((m) => m[1])
}

// Job names under `needs:`. All three legal spellings, because a parse miss
// reports "no dependencies" and would turn this test's central assertion into a
// silent pass. Returns null when a `needs:` key exists but nothing parses out.
// Copied from publish-gpr-skip-policy.test.mjs.
function needsOf(jobText) {
  if (!jobText) return []
  if (!/^ {4}needs:/m.test(jobText)) return []

  const inline = jobText.match(/^ {4}needs:[ \t]*\[([^\]]*)\]/m)
  if (inline) {
    const names = inline[1].split(',').map((s) => s.trim()).filter(Boolean)
    return names.length ? names : null
  }

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

// Job-level `uses:` (4-space indent) — a reusable-workflow call. Step-level
// `uses:` sits at 8+ spaces and is deliberately not matched.
function jobUses(jobText) {
  if (!jobText) return null
  const match = jobText.match(/^ {4}uses:[ \t]*(\S+)/m)
  return match ? match[1] : null
}

// The job's `with:` block, as text.
function withBlock(jobText) {
  if (!jobText) return ''
  const match = jobText.match(/^ {4}with:[ \t]*\n((?: {6}.*\n| *\n)*)/m)
  return match ? match[1] : ''
}

// A local reusable workflow path (`./.github/workflows/x.yml`) → repo-relative
// path. Anything else (a pinned `owner/repo/.github/workflows/...@sha`) returns
// null: it is not editable here, so it is out of scope for this test.
function localWorkflowPath(uses) {
  if (!uses || !uses.startsWith('./')) return null
  return uses.slice(2)
}

// Does this reusable workflow accept the overlay artifact input?
function declaresOverlayInput(relativePath) {
  if (!existsSync(join(root, relativePath))) return false
  return new RegExp(`^ {6}${OVERLAY_INPUT}:`, 'm').test(read(relativePath))
}

// Packages whose package.json depends on @qvac/fabric — i.e. those that consume
// the npm PREBUILDS TREE and therefore need the overlay. Not the full set of
// packages that link against fabric; see the SCOPE note in the header before
// widening this to vcpkg.json.
function fabricConsumerPackages() {
  return readdirSync(PACKAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'fabric')
    .filter((name) => {
      const manifest = join(PACKAGE_DIR, name, 'package.json')
      if (!existsSync(manifest)) return false
      return /"@qvac\/fabric"\s*:/.test(readFileSync(manifest, 'utf8'))
    })
    .sort()
}

const WORKFLOWS = onPrWorkflows()
const CONSUMER_PACKAGES = fabricConsumerPackages()

// Workflows that detect the stack at all — consumers and the producer both.
const DETECTING_WORKFLOWS = WORKFLOWS.filter((relativePath) =>
  jobBlock(read(relativePath), DETECT_JOB) !== null
)

// Consumers resolve an artifact somebody else builds. The producer does not.
const FABRIC_WORKFLOWS = DETECTING_WORKFLOWS.filter((relativePath) =>
  jobBlock(read(relativePath), RESOLVE_JOB) !== null
)

test('on-pr workflows and fabric consumers were discovered', () => {
  assert.ok(WORKFLOWS.length >= 10, `found ${WORKFLOWS.length} on-pr workflows`)
  assert.ok(
    CONSUMER_PACKAGES.length >= 5,
    `found ${CONSUMER_PACKAGES.length} fabric consumers: ${CONSUMER_PACKAGES.join(', ')}`
  )
  assert.ok(
    FABRIC_WORKFLOWS.length >= 5,
    `found ${FABRIC_WORKFLOWS.length} on-pr workflows with a ${DETECT_JOB} job`
  )
})

// Dropping `resolve-fabric-prebuilds` is exactly how a consumer would fall out
// of every assertion below while still looking fabric-aware. Only the producer
// may be in that state, so name it: any other workflow that detects the stack
// without resolving an artifact is a consumer that has lost its hand-off.
test('only the fabric producer detects the stack without resolving an artifact', () => {
  const producerOnly = DETECTING_WORKFLOWS.filter(
    (relativePath) => !FABRIC_WORKFLOWS.includes(relativePath)
  )
  assert.deepEqual(
    producerOnly,
    ['.github/workflows/on-pr-fabric.yml'],
    `these workflows have a ${DETECT_JOB} job but no ${RESOLVE_JOB} job, so every overlay assertion silently skips them: ${producerOnly.join(', ')}`
  )
})

// A new fabric consumer whose on-PR workflow never detects the stack would make
// every assertion below vacuous for that package — it would be exempt by
// omission, which is the failure mode that let cpp-lint drift in the first
// place. Tie the package list to the workflow list explicitly.
test('every fabric-consumer package has an on-pr workflow that detects the stack', () => {
  const detectingSources = FABRIC_WORKFLOWS.map((p) => read(p))
  const missing = CONSUMER_PACKAGES.filter(
    (pkg) => !detectingSources.some((source) => source.includes(`packages/${pkg}`))
  )
  assert.deepEqual(
    missing,
    [],
    `packages depend on @qvac/fabric but no on-pr workflow with a ${DETECT_JOB} job references them: ${missing.join(', ')}`
  )
})

for (const relativePath of FABRIC_WORKFLOWS) {
  const source = read(relativePath)
  const slug = relativePath.replace(/.*on-pr-|\.ya?ml$/g, '')

  for (const jobName of jobNames(source)) {
    const jobText = jobBlock(source, jobName)
    const target = localWorkflowPath(jobUses(jobText))
    if (!target || !declaresOverlayInput(target)) continue

    test(`${slug}: ${jobName} passes ${OVERLAY_INPUT} to ${target.replace('.github/workflows/', '')}`, () => {
      const passed = withBlock(jobText)
      assert.match(
        passed,
        new RegExp(`^ {6}${OVERLAY_INPUT}:`, 'm'),
        `${relativePath} job '${jobName}' calls ${target}, which accepts ${OVERLAY_INPUT}, but never passes it — this lane compiles the addon against the published fabric, not the PR's`
      )

      // Guard the exact producer expression. A hand-rolled variant that reads
      // fabric_stack instead of needs_fabric_artifact would wait on an artifact
      // on-pr-fabric never publishes.
      assert.match(
        passed,
        new RegExp(`${OVERLAY_INPUT}:[^\\n]*needs\\.${DETECT_JOB}\\.outputs\\.needs_fabric_artifact`),
        `${relativePath} job '${jobName}' passes ${OVERLAY_INPUT} but not off needs.${DETECT_JOB}.outputs.needs_fabric_artifact`
      )
    })

    test(`${slug}: ${jobName} declares the fabric jobs it reads`, () => {
      const deps = needsOf(jobText)
      assert.notEqual(
        deps,
        null,
        `${relativePath} job '${jobName}' has a needs: key that did not parse — fix the parser rather than trusting this test`
      )
      // needs.<job> resolves to empty for a non-dependency, so a missing entry
      // here disables the overlay silently instead of failing the run.
      assert.ok(
        deps.includes(DETECT_JOB),
        `${relativePath} job '${jobName}' reads needs.${DETECT_JOB} but does not depend on it — the expression resolves to empty and the overlay never runs`
      )
      assert.ok(
        deps.includes(RESOLVE_JOB),
        `${relativePath} job '${jobName}' would run before ${RESOLVE_JOB} republishes the artifact it downloads`
      )
    })
  }
}

// The overlay rewrites node_modules/@qvac/fabric/prebuilds in place; `bare-make
// generate` is what bakes those include paths into compile_commands.json, which
// is the only thing clang-tidy reads. Either step on the wrong side of that
// boundary and the job goes green having linted the published headers.
test('cpp-lint overlays fabric after npm install and before generating the build system', () => {
  const source = read('.github/workflows/cpp-lint.yaml')

  const installAt = source.indexOf('name: Install npm dependencies')
  const downloadAt = source.indexOf('name: Download fabric-prebuilds for overlay')
  const overlayAt = source.indexOf('name: Overlay PR @qvac/fabric prebuilds')
  const generateAt = source.indexOf('name: Generate build system')

  assert.ok(installAt !== -1, 'cpp-lint.yaml lost its npm install step')
  assert.ok(downloadAt !== -1, 'cpp-lint.yaml has no fabric-prebuilds download step')
  assert.ok(overlayAt !== -1, 'cpp-lint.yaml has no fabric overlay step')
  assert.ok(generateAt !== -1, 'cpp-lint.yaml lost its bare-make generate step')

  assert.ok(
    installAt < downloadAt && downloadAt < overlayAt && overlayAt < generateAt,
    'cpp-lint.yaml step order must be: npm install -> download fabric-prebuilds -> overlay -> generate'
  )
})

// Both overlay steps must carry the same guard, or a non-fabric PR fails trying
// to download an artifact no job in the run ever uploaded.
//
// Matched on the guard expression alone, independent of where `if:` sits in the
// step. cpp-lint.yaml writes `- if:` before `name:` (its ROCm and Vulkan steps
// do the same), while the cpp-tests-*/integration-test-* lanes write `- name:`
// first. Pinning the key order would fail this test on a purely cosmetic
// reformat, reporting "found 0" while both guards were perfectly intact.
test('cpp-lint overlay steps are guarded on the artifact input being set', () => {
  const source = read('.github/workflows/cpp-lint.yaml')
  const guards = [...source.matchAll(
    new RegExp(`^ +(?:- )?if: \\$\\{\\{ inputs\\.${OVERLAY_INPUT} != '' \\}\\}$`, 'gm')
  )]
  assert.equal(
    guards.length,
    2,
    `expected both cpp-lint overlay steps guarded on ${OVERLAY_INPUT} != '', found ${guards.length}`
  )
})

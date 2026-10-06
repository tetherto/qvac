// Resolves the prebuilds artifact of a named workflow run so a mobile dispatch
// can install the binaries that run already built.
//
// Helpers are pure and the HTTP client is injected, so the decision surface is
// covered by test/resolve-prebuild-run.test.mjs without a network or a token.
// `gh` is not used: mobile jobs run on self-hosted runners where the CLI is not
// guaranteed, while Node comes from the setup action's own setup-node step.

import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAX_ARTIFACT_PAGES = 10

// Platform -> the prebuild dir the mobile build consumes. The setup action fans
// these out to the other ABIs afterwards, so only the built dir matters here.
export const PLATFORM_PREBUILD_DIRS = {
  Android: ['android-arm64'],
  iOS: ['ios-arm64'],
}

// The run id arrives from a workflow_dispatch input and ends up in an API path.
export function parseRunId(raw) {
  const value = String(raw ?? '').trim()
  return /^[1-9][0-9]*$/.test(value) ? value : null
}

// Matches how reusable-prebuilds.yml names the merged bundle.
export function mergedArtifactName(addonWorkdir) {
  if (!isSafeWorkdir(addonWorkdir)) return null
  const segments = String(addonWorkdir)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  const name = segments[segments.length - 1]
  if (!name) return null
  return `prebuilds-${name}`
}

// addon-workdir reaches a `rm -rf "addon/$ADDON_WORKDIR/prebuilds"` and the
// download path, and 8 of the mobile workflows expose it as a dispatch input.
// A traversing value would delete a sibling checkout on a persistent
// self-hosted runner, so reject anything that is not a plain relative path.
export function isSafeWorkdir(addonWorkdir) {
  const value = String(addonWorkdir ?? '')
  if (value === '' || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  if (value.includes('\\') || value.includes('\0')) return false
  return value.split('/').every((segment) => segment !== '..')
}

// Bare `prebuilds` is the legacy name, kept so an older run id still resolves.
export function candidateArtifactNames(addonWorkdir) {
  const merged = mergedArtifactName(addonWorkdir)
  return merged ? [merged, 'prebuilds'] : ['prebuilds']
}

export function platformPrebuildDirs(platform) {
  return PLATFORM_PREBUILD_DIRS[String(platform ?? '').trim()] ?? []
}

// A live artifact wins in candidate order. "Expired" is only reported when every
// candidate is expired, because expired and never-existed need different advice.
export function selectArtifact(artifacts, candidates) {
  const rows = Array.isArray(artifacts) ? artifacts : []

  // The bare `prebuilds` name carries no addon identity — it is whatever that
  // run happened to build. Only fall back to it when the addon's OWN bundle is
  // absent from the run entirely. Preferring a live bare row over an EXPIRED
  // `prebuilds-<pkg>` would install another addon's binaries under this addon's
  // name and go green, which is the failure class this route exists to close;
  // the npm route guards the same thing with its PACKED_ADDON assertion.
  const [own] = candidates
  const ownPresent = rows.some((row) => row?.name === own)
  const usable = ownPresent ? [own] : candidates

  // A re-run leaves the earlier attempt's artifacts under the same run id, so a
  // run can hold two live rows with the same name. Take the NEWEST: first-match
  // would freeze whichever the API happened to list first (id-ascending in
  // practice, i.e. the pre-re-run binary) while the provenance line printed the
  // same head_sha either way — a stale .bare on the device, and a log that looks
  // right. created_at breaks the tie when ids are not comparable.
  const newest = (a, b) => {
    const at = Date.parse(a?.created_at ?? '')
    const bt = Date.parse(b?.created_at ?? '')
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at > bt ? a : b
    return (Number(a?.id) || 0) >= (Number(b?.id) || 0) ? a : b
  }

  for (const name of usable) {
    const live = rows
      .filter((row) => row?.name === name && row?.expired !== true)
      .reduce((best, row) => (best ? newest(best, row) : row), null)
    if (live) return { name, id: live.id ?? null, expired: false }
  }
  for (const name of usable) {
    if (rows.some((row) => row?.name === name)) {
      return { name, id: null, expired: true }
    }
  }
  return null
}

// A run id and a pinned package are two answers to "which binary goes on the
// phone", so a caller that sets both is told to choose rather than guessed at.
export function conflictingSource({ packageVersion, forceNpmPrebuild }) {
  const pinned = String(packageVersion ?? '').trim()
  if (pinned !== '') return `package/package_spec='${pinned}'`
  if (String(forceNpmPrebuild ?? '').trim() === 'true') {
    return 'force-npm-prebuild=true'
  }
  return null
}

// A fork PR's on-pr run is pull_request_target, so it appears in the base repo's
// run list while its head_repository is the fork. This warns rather than
// refusing: the repo is fork-first (docs/gitflow.md), and a fork's prebuilds only
// exist once the merge/release team approved `fork-ci` on that run.
export function sourceRepositoryWarning(run, repo) {
  const headRepo = run?.head_repository?.full_name
  if (!headRepo) {
    return (
      `run ${run?.id} reports no head repository, so which repository built these ` +
      'binaries cannot be confirmed from the API.'
    )
  }
  if (headRepo !== repo) {
    return (
      `run ${run?.id} built code from the FORK '${headRepo}', not '${repo}'. ` +
      'That is normal for a fork PR and the run passed fork-ci approval to build ' +
      "at all — but confirm you meant that contributor's code."
    )
  }
  return null
}

export function formatProvenance(run, artifactName) {
  const name = run?.name ?? 'unknown workflow'
  const sha = run?.head_sha ?? 'unknown'
  const branch = run?.head_branch ?? 'unknown'
  const conclusion = run?.conclusion ?? run?.status ?? 'unknown'
  return (
    `Verified: prebuilds come from run ${run?.id} — artifact '${artifactName}', ` +
    `workflow '${name}', head ${sha}, branch ${branch} ` +
    `(${run?.head_repository?.full_name ?? 'unknown repo'}), ${conclusion}`
  )
}

// A red run can still hold good prebuilds: the prebuild job uploads before the
// desktop tests and lint that colour the run. Warn instead of refusing.
export function conclusionWarning(run) {
  const conclusion = String(run?.conclusion ?? '').trim()
  if (conclusion === '' || conclusion === 'success') return null
  return (
    `run ${run?.id} concluded '${conclusion}'. Its prebuilds artifact exists and will be used; ` +
    'check that the prebuild job itself is the green one before trusting the result.'
  )
}

// Which addons a run built a bundle for. A real nx run carries 65+ artifacts, so
// listing them all buries the answer, which is usually "nx decided your addon
// wasn't affected".
export function describeAvailableBundles(artifacts, limit = 12) {
  const rows = Array.isArray(artifacts) ? artifacts : []
  if (rows.length === 0) return ['That run published no artifacts at all.']

  const bundles = [
    ...new Set(
      rows
        .map((row) => row?.name)
        .filter((name) => typeof name === 'string' && name.startsWith('prebuilds-'))
        // The per-PR reuse marker is also a `prebuilds-` artifact but is not a
        // bundle, and would read as an addon name.
        .filter((name) => !name.startsWith('prebuilds-cache-pr-'))
        .map((name) => name.slice('prebuilds-'.length)),
    ),
  ].sort()

  if (bundles.length === 0) {
    return [
      `That run published ${rows.length} artifact(s) but no prebuilds bundle — it does not build prebuilds.`,
      "Use the addon's on-pr-<addon>.yml (or prebuilds-<addon>.yml) run instead.",
    ]
  }

  const shown = bundles.slice(0, limit).join(', ')
  const rest = bundles.length > limit ? `, +${bundles.length - limit} more` : ''
  return [
    `That run built prebuilds for: ${shown}${rest}.`,
    'On the nx path a run only builds the addons it decided were affected, so yours may not be there.',
  ]
}

class ResolveError extends Error {
  constructor(message, hints = []) {
    super(message)
    this.hints = hints
  }
}

async function apiJson(request, url, token) {
  const response = await request(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  })
  if (response.status === 404) return { notFound: true, body: null }
  if (!response.ok) {
    throw new ResolveError(
      `GitHub API returned ${response.status} for ${url}`,
      response.status === 403 || response.status === 401
        ? [
            "The job needs 'actions: read' and a token that carries it.",
            "Add `actions: read` to the build job's permissions block.",
          ]
        : [],
    )
  }
  return { notFound: false, body: await response.json() }
}

async function listArtifacts(request, apiUrl, repo, runId, token) {
  const artifacts = []
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const url = `${apiUrl}/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`
    const { notFound, body } = await apiJson(request, url, token)
    // An empty body and an empty run are different facts; conflating them
    // reported "published no artifacts at all" for a failed listing.
    if (notFound || !body) {
      throw new ResolveError(`Could not list run ${runId}'s artifacts (the API returned no listing).`, [
        `Check https://github.com/${repo}/actions/runs/${runId}`,
        "If the run exists, the token may lack 'actions: read'.",
      ])
    }
    const rows = body.artifacts ?? []
    artifacts.push(...rows)
    if (rows.length < 100) return artifacts
  }
  throw new ResolveError(
    `Run ${runId} has more than ${MAX_ARTIFACT_PAGES * 100} artifacts, so the listing was truncated.`,
    ['The bundle may exist beyond the page bound — raise MAX_ARTIFACT_PAGES in resolve-prebuild-run.mjs.'],
  )
}

// Resolves everything the action needs before a byte is downloaded. Never falls
// back to another prebuild source: a run id that cannot be honoured fails.
export async function resolvePrebuildRun({ env, request }) {
  const rawRunId = env.PREBUILD_RUN_ID ?? ''
  const runId = parseRunId(rawRunId)
  if (!runId) {
    throw new ResolveError(
      `prebuild_run_id must be a numeric GitHub Actions run id, got '${rawRunId}'.`,
      [
        'Copy it from the run URL: https://github.com/<owner>/<repo>/actions/runs/<run id>.',
        'Or: gh run list --workflow on-pr-<addon>.yml --branch <branch> --status success --json databaseId',
      ],
    )
  }

  const conflict = conflictingSource({
    packageVersion: env.PACKAGE_VERSION,
    forceNpmPrebuild: env.FORCE_NPM_PREBUILD,
  })
  if (conflict) {
    throw new ResolveError(
      `prebuild_run_id and a pinned package are mutually exclusive (${conflict}).`,
      [
        `prebuild_run_id installs run ${runId}'s prebuilds artifact; package/package_spec installs a published or GPR build.`,
        'Clear whichever one you did not mean and dispatch again.',
      ],
    )
  }

  const token = String(env.GITHUB_TOKEN ?? '').trim()
  if (!token) {
    throw new ResolveError('prebuild_run_id needs a token with actions:read, but none was supplied.', [
      'The calling workflow must pass pat-token (secrets.GITHUB_TOKEN is enough).',
      "The build job also needs 'actions: read' in its permissions block.",
    ])
  }

  const repo = String(env.REPO ?? '').trim()
  if (!repo) throw new ResolveError('REPO must name the repository holding the run.')

  if (!isSafeWorkdir(env.ADDON_WORKDIR)) {
    throw new ResolveError(
      `addon-workdir '${env.ADDON_WORKDIR ?? ''}' is not a plain relative path.`,
      [
        'It selects the directory that gets cleared and written to, so an absolute',
        'path or one containing ".." is refused before anything is deleted.',
      ],
    )
  }

  const platform = String(env.PLATFORM ?? '').trim()
  const expectedDirs = platformPrebuildDirs(platform)
  if (expectedDirs.length === 0) {
    throw new ResolveError(`Unknown platform '${platform}' — expected Android or iOS.`)
  }

  const apiUrl = String(env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')

  const { notFound, body: run } = await apiJson(
    request,
    `${apiUrl}/repos/${repo}/actions/runs/${runId}`,
    token,
  )
  if (notFound || !run) {
    throw new ResolveError(`Run ${runId} does not exist in ${repo}, or this token cannot see it.`, [
      `Check https://github.com/${repo}/actions/runs/${runId}`,
      `The id must be a run in ${repo}'s own Actions list — a run from a fork's own`,
      'Actions tab is a different repository and does not resolve here.',
    ])
  }

  const candidates = candidateArtifactNames(env.ADDON_WORKDIR)
  const artifacts = await listArtifacts(request, apiUrl, repo, runId, token)
  const selected = selectArtifact(artifacts, candidates)

  if (!selected) {
    // An unfinished run is the likeliest reason a bundle is missing, and saying
    // "does not build prebuilds" there sends the reader to the wrong run.
    const status = String(run.status ?? '').trim()
    if (status !== '' && status !== 'completed') {
      throw new ResolveError(
        `Run ${runId} is still '${status}', so its prebuilds artifact has not been uploaded yet.`,
        [
          `Watch it: https://github.com/${repo}/actions/runs/${runId}`,
          'The prebuild job uploads part-way through the run — wait for it, then dispatch again with the same run id.',
        ],
      )
    }
    throw new ResolveError(
      `Run ${runId} has no ${candidates.map((name) => `'${name}'`).join(' or ')} artifact.`,
      [
        `That run is '${run.name ?? 'unknown'}' (${run.path ?? 'unknown path'}).`,
        ...describeAvailableBundles(artifacts),
      ],
    )
  }

  if (selected.expired) {
    throw new ResolveError(`Run ${runId}'s '${selected.name}' artifact has expired.`, [
      'Artifacts expire (retention is set per repository), so a run id stops being usable once its prebuilds are gone.',
      'Re-run the prebuild job on your PR and dispatch against the new run id.',
    ])
  }

  return {
    runId,
    artifactName: selected.name,
    artifactId: selected.id,
    headSha: run.head_sha ?? '',
    headBranch: run.head_branch ?? '',
    expectedDirs,
    provenance: formatProvenance({ ...run, id: runId }, selected.name),
    warnings: [
      sourceRepositoryWarning({ ...run, id: runId }, repo),
      conclusionWarning({ ...run, id: runId }),
    ].filter(Boolean),
  }
}

function writeOutputs(outputPath, outputs) {
  if (!outputPath) return
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  appendFileSync(outputPath, `${lines}\n`)
}

export async function main({ env = process.env, request = fetch, log = console } = {}) {
  try {
    const resolved = await resolvePrebuildRun({ env, request })
    for (const warning of resolved.warnings) log.log(`::warning::${warning}`)
    log.log(resolved.provenance)
    writeOutputs(env.GITHUB_OUTPUT, {
      artifact_name: resolved.artifactName,
      // The download selects by id: a re-run leaves the earlier attempt's
      // artifacts under the same run id, so a run can hold two live rows with
      // the same name.
      artifact_id: resolved.artifactId ?? '',
      source_run_id: resolved.runId,
      head_sha: resolved.headSha,
      head_branch: resolved.headBranch,
      expected_dirs: resolved.expectedDirs.join(' '),
    })
    return 0
  } catch (error) {
    log.log(`::error::${error.message}`)
    for (const hint of error.hints ?? []) log.log(hint)
    return 1
  }
}

// Realpaths, not URL strings: import.meta.url is the percent-encoded realpath
// while argv[1] is the literal path, so a naive comparison breaks whenever a
// segment is a symlink (macOS /tmp -> /private/tmp). That failure was silent —
// main() never ran and the step still exited 0.
function invokedAsScript() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  process.exitCode = await main()
}

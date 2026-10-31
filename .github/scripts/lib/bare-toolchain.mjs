/**
 * Compare the bare toolchain pinned in .github/bare-toolchain/package-lock.json
 * with what npm publishes, and check the tools on PATH come from it.
 *
 * Only the packages that change what a build produces are watched. Their
 * per-platform packages are released in lockstep with them, and the remaining
 * entries are bare-make's own JavaScript dependencies.
 */

'use strict'

import { posix, win32 } from 'node:path'

export const WATCHED = [
  'bare-make',
  'cmake-toolchains',
  'llvm-runtime',
  'cmake-runtime',
  'ninja-runtime',
  'nasm-runtime',
]

export const ISSUE_TITLE = 'bare toolchain update available'
export const ISSUE_LABEL = 'toolchain-drift'
const MARKER = 'bare-toolchain-drift'

export function lockedVersions(lockfile) {
  const packages = lockfile?.packages ?? {}
  const versions = {}
  for (const name of WATCHED) {
    const entry = packages[`node_modules/${name}`]
    if (!entry?.version) throw new Error(`${name} is missing from the bare toolchain lockfile`)
    versions[name] = entry.version
  }
  return versions
}

function parse(version) {
  const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a, b) {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) throw new Error(`cannot compare versions ${a} and ${b}`)
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i]
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return left.pre < right.pre ? -1 : 1
}

export function findDrift(locked, latestByName) {
  const drift = []
  for (const name of WATCHED) {
    const latest = latestByName[name]
    if (latest && compareVersions(latest, locked[name]) > 0) {
      drift.push({ name, locked: locked[name], latest })
    }
  }
  return drift
}

/** Stable identity of a drift set, so the issue changes only when npm does. */
export function driftKey(drift) {
  return drift.map(({ name, latest }) => `${name}@${latest}`).join(',')
}

export function keyFromIssueBody(body) {
  const match = String(body ?? '').match(new RegExp(`<!-- ${MARKER}: ([^ ]*) -->`))
  return match ? match[1] : null
}

export function issueBody(drift) {
  const rows = drift.map(({ name, locked, latest }) => `| \`${name}\` | ${locked} | ${latest} |`)
  return [
    `<!-- ${MARKER}: ${driftKey(drift)} -->`,
    'npm has a newer release of the bare toolchain than `.github/bare-toolchain/package-lock.json` pins. CI keeps building with the locked versions, so nothing is broken; this is the signal to review the release and move the lock.',
    '',
    '| Package | Locked | Latest |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'To move the lock:',
    '',
    '1. Merge the Dependabot pull request for `/.github/bare-toolchain`, or run `npm install --package-lock-only` there after editing the `bare-make` pin.',
    '2. Add the `prebuilds` and `run-cpp-addon-tests` labels to that pull request. **On PR Trigger (Fabric)** then builds every fabric prebuild and runs cpp-lint, and **On PR Trigger (nx)** runs the llm-llamacpp C++ tests and coverage report against that fabric.',
    '3. A new llvm-runtime major also moves the libc++ that fabric embeds and exports to every addon, so release fabric before the addons pick it up.',
    "4. Once it merges, move every `setup-bare-tooling` SHA pin (`grep -rl 'setup-bare-tooling@' .github/workflows`) to its merge commit. A pinned action installs the lock from its own commit, so those workflows build with the old toolchain until then.",
    '',
    'This issue is updated when a newer release appears and closed once the lock catches up. Closing it by hand puts this release off: it is not reported again, and the next newer release opens a new issue.',
  ].join('\n')
}

/**
 * Open, update or close the one tracking issue to match the drift found on
 * main. Closing an issue puts its release off: the same drift key is not
 * reported again, and the next newer release opens a new issue. `github` is
 * actions/github-script's Octokit.
 */
export async function syncDriftIssue({ github, owner, repo, runUrl, drift, key, body, log = () => {} }) {
  const issues = (
    await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: 'all', labels: ISSUE_LABEL, per_page: 100,
    })
  ).filter((issue) => issue.pull_request === undefined && issue.title === ISSUE_TITLE)
  const open = issues.find((issue) => issue.state === 'open')

  if (!drift) {
    if (!open) return
    await github.rest.issues.createComment({
      owner, repo, issue_number: open.number,
      body: `The lock matches the latest releases on npm again. Closing. (${runUrl})`,
    })
    await github.rest.issues.update({ owner, repo, issue_number: open.number, state: 'closed' })
    log(`Closed #${open.number}`)
    return
  }

  if (open) {
    if (keyFromIssueBody(open.body) === key) {
      log(`#${open.number} already reports ${key}`)
      return
    }
    await github.rest.issues.update({ owner, repo, issue_number: open.number, body })
    await github.rest.issues.createComment({
      owner, repo, issue_number: open.number,
      body: `Newer releases: ${key.split(',').join(', ')}. The table above is current. (${runUrl})`,
    })
    log(`Updated #${open.number}`)
    return
  }

  const deferred = issues.find((issue) => keyFromIssueBody(issue.body) === key)
  if (deferred) {
    log(`#${deferred.number} reported ${key} and was closed; waiting for a newer release`)
    return
  }

  try {
    await github.rest.issues.getLabel({ owner, repo, name: ISSUE_LABEL })
  } catch (error) {
    if (error.status !== 404) throw error
    await github.rest.issues.createLabel({
      owner, repo, name: ISSUE_LABEL, color: 'fbca04',
      description: 'npm has a newer bare toolchain than .github/bare-toolchain pins',
    })
  }
  const created = await github.rest.issues.create({ owner, repo, title: ISSUE_TITLE, body, labels: [ISSUE_LABEL] })
  log(`Opened #${created.data.number}`)
}

/**
 * First version-looking token of a tool's `--version` output. clang prints
 * "clang version 23.1.3 (...)" and bare-make prints the bare version.
 */
export function reportedVersion(output) {
  const match = String(output).match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

export const PATH_TOOLS = ['bare-make', 'clang', 'llvm-profdata']

/**
 * The file a shell runs for `tool`: the first PATH entry holding it, trying
 * each PATHEXT extension on Windows, where a bare name does not run.
 */
export function findOnPath(tool, { path, pathext = '', platform, exists }) {
  const windows = platform === 'win32'
  const paths = windows ? win32 : posix
  const names = windows
    ? pathext.split(';').filter(Boolean).map((ext) => `${tool}${ext.toLowerCase()}`)
    : [tool]
  for (const dir of path.split(windows ? ';' : ':')) {
    if (!dir) continue
    for (const name of names) {
      const file = paths.join(dir, name)
      if (exists(file)) return file
    }
  }
  return null
}

/**
 * Tools that PATH does not resolve to the lock's bin directory. Checked by
 * location rather than version: llvm-runtime's own version can move in a
 * packaging-only release without the clang it bundles changing.
 */
export function pathMismatches(bin, found, platform) {
  const paths = platform === 'win32' ? win32 : posix
  const normalize = (dir) => {
    const normalized = paths.normalize(dir).replace(/[\\/]+$/, '')
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const mismatches = []
  for (const tool of PATH_TOOLS) {
    const file = found[tool] ?? null
    if (file === null || normalize(paths.dirname(file)) !== normalize(bin)) {
      mismatches.push({ tool, actual: file })
    }
  }
  return mismatches
}

'use strict'

// Resolves the benchmark "sources" (candidate / baseline) to a concrete
// addon entrypoint the case-runner can `require()`.
//
// V1 scope:
//   - candidate (type='addon', source='local'): the addon as built in
//     the working tree. Picked up via the existing
//     `require('@qvac/llm-llamacpp')` resolution from this package's
//     node_modules (npm link / npm install -w).
//   - candidate (type='addon', source='npm'): the package the user has
//     pinned in node_modules.
//   - baseline (type='addon', source='commit'): git-worktree-based.
//     We resolve a commit SHA (literal or 'merge-base'); the local-dev
//     loop in V1 either (a) skips the baseline build, (b) consumes a
//     pre-built directory passed via --baseline-addon-path, or (c)
//     builds via bare-make inside a worktree (CI path; documented in
//     README — not auto-invoked by default to keep `run-vlm-bench` fast
//     locally).
//   - baseline (type='skip'): candidate-only run; no diff.
//
// Open follow-up: the auto-build path for baseline (bare-make inside a
// git worktree, cache by SHA) is the CI half of concern 7.1. Local
// usage should pass --baseline-addon-path for now.

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function execGit (args, opts = {}) {
  try {
    return execSync(`git ${args}`, { ...opts, encoding: 'utf8' }).trim()
  } catch (e) {
    return null
  }
}

function resolveMergeBase () {
  // Prefer origin/main; fall back to local main if no remote.
  let base = execGit('merge-base HEAD origin/main')
  if (!base) base = execGit('merge-base HEAD main')
  return base
}

function resolveCommit (spec) {
  if (!spec || spec === 'merge-base') return resolveMergeBase()
  // Resolve any ref (tag, branch, short SHA) to the full SHA.
  const sha = execGit(`rev-parse --verify ${spec}^{commit}`)
  return sha || spec
}

function resolveSource (key, spec, cliOverrides) {
  if (!spec || spec.type === 'skip') {
    return { key, type: 'skip' }
  }
  if (spec.type === 'addon' && spec.source === 'local') {
    return { key, type: 'addon', source: 'local', label: 'addon@candidate' }
  }
  if (spec.type === 'addon' && spec.source === 'npm') {
    return { key, type: 'addon', source: 'npm', label: 'addon@npm' }
  }
  if (spec.type === 'addon' && spec.source === 'commit') {
    const commit = resolveCommit(cliOverrides.commit || spec.commit)
    const shortSha = commit ? commit.slice(0, 8) : 'unknown'
    const addonPath = cliOverrides.addonPath || null
    if (addonPath && !fs.existsSync(addonPath)) {
      throw new Error(`--baseline-addon-path=${addonPath}: not found`)
    }
    return {
      key,
      type: 'addon',
      source: 'commit',
      commit,
      label: `addon@${shortSha}`,
      addonPath,                  // may be null — caller must build, or skip
      requiresBuild: !addonPath
    }
  }
  throw new Error(`Unknown source spec for ${key}: ${JSON.stringify(spec)}`)
}

function resolveSources (config, args) {
  const out = []
  out.push(resolveSource('candidate', config.sources.candidate, {}))
  if (args['skip-baseline']) {
    out.push({ key: 'baseline', type: 'skip' })
  } else {
    out.push(resolveSource('baseline', config.sources.baseline, {
      commit: args['baseline-commit'],
      addonPath: args['baseline-addon-path']
    }))
  }
  return out
}

module.exports = { resolveSources, resolveMergeBase, resolveCommit }

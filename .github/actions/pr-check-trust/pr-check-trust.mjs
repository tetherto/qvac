#!/usr/bin/env node
// Forks need a SHA-bound approval: a synchronize's actor may not be the commit's author.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const APPROVAL_CONTEXT = 'qvac/fork-verified'

export function decide({
  event,
  action,
  isDraft,
  headRepo,
  baseRepo,
  hasWrite,
  approved,
  label,
  labels
}) {
  if (event !== 'pull_request_target' && event !== 'pull_request') {
    return {
      allowed: true,
      level: 'notice',
      reason: `Non-PR event (${event}), authorized`
    }
  }
  if (isDraft)
    return {
      allowed: false,
      level: 'notice',
      reason: 'Draft PR, blocked until ready for review'
    }
  if (headRepo && headRepo.toLowerCase() === baseRepo.toLowerCase()) {
    return {
      allowed: true,
      level: 'notice',
      reason: 'Same-repo PR, authorized'
    }
  }
  if (hasWrite) {
    return approved
      ? {
          allowed: true,
          level: 'notice',
          reason: 'Write-capable actor with SHA-bound fork-ci approval, authorized'
        }
      : {
          allowed: false,
          level: 'warning',
          reason: 'Write-capable actor on a fork without SHA-bound fork-ci approval, skipping'
        }
  }
  if (!label) {
    return approved
      ? {
          allowed: true,
          level: 'notice',
          reason: 'Fork PR with SHA-bound fork-ci approval, authorized'
        }
      : {
          allowed: false,
          level: 'warning',
          reason: 'Fork PR without fork-ci approval on this SHA, skipping'
        }
  }
  const hasLabel = Array.isArray(labels) && labels.includes(label)
  if (action === 'synchronize' && !hasLabel) {
    return {
      allowed: false,
      level: 'warning',
      reason: `Fork synchronize without '${label}', skipping`
    }
  }
  if (hasLabel && approved)
    return {
      allowed: true,
      level: 'notice',
      reason: `Fork PR with '${label}' and SHA-bound approval, authorized`
    }
  if (hasLabel)
    return {
      allowed: false,
      level: 'warning',
      reason: `Fork PR with '${label}' but no SHA-bound approval, skipping`
    }
  return {
    allowed: false,
    level: 'warning',
    reason: `Fork PR without '${label}', skipping`
  }
}

// The API lists statuses newest first.
export function isApproved(statuses, context = APPROVAL_CONTEXT) {
  const match = (statuses || []).find((s) => s && s.context === context)
  return Boolean(match && match.state === 'success')
}

export function hasWritePermission(body) {
  return body && (body.permission === 'admin' || body.permission === 'write')
}

async function api(path, token) {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com'
  const res = await fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }
  })
  return res.ok ? res.json() : null
}

async function main(env) {
  const isPr = env.EVENT === 'pull_request_target' || env.EVENT === 'pull_request'
  const perm = await api(
    `/repos/${env.BASE_REPO}/collaborators/${encodeURIComponent(env.GITHUB_ACTOR)}/permission`,
    env.GH_TOKEN
  )
  const statuses =
    isPr && env.HEAD_SHA
      ? await api(`/repos/${env.BASE_REPO}/commits/${env.HEAD_SHA}/statuses`, env.GH_TOKEN)
      : []
  const hasWrite = hasWritePermission(perm)
  const result = decide({
    event: env.EVENT,
    action: env.ACTION,
    isDraft: env.IS_DRAFT === 'true',
    headRepo: env.HEAD_REPO || '',
    baseRepo: env.BASE_REPO,
    hasWrite,
    approved: isApproved(statuses),
    label: env.LABEL_NAME || '',
    labels: JSON.parse(env.LABELS_JSON || 'null')
  })
  console.log(`::${result.level}::${result.reason}`)
  appendFileSync(env.GITHUB_OUTPUT, `allowed=${result.allowed}\nhas_write=${hasWrite ? 1 : ''}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.env)

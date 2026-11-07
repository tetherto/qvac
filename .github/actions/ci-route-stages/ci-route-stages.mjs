#!/usr/bin/env node
// Not a trust decision: secret-bearing jobs also need fork approval.

import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const TRUSTED_EVENTS = ['workflow_dispatch', 'workflow_call', 'push', 'schedule']
export const OUTPUTS = [
  'run_verified_checks',
  'run_prebuilds',
  'run_cpp_tests',
  'run_desktop',
  'run_mobile'
]

export function route({ event, labels, headRepo, isDraft }) {
  if (TRUSTED_EVENTS.includes(event)) return Object.fromEntries(OUTPUTS.map((o) => [o, true]))
  const has = (l) => Array.isArray(labels) && labels.includes(l)
  const authorized = Boolean(headRepo) && !isDraft
  const desktop = authorized && has('run-desktop-addon-tests')
  const mobile = authorized && has('run-mobile-addon-tests')
  // C++ and desktop tests restore the build's outputs, so they build too.
  const cpp = authorized && has('run-cpp-addon-tests')
  return {
    run_verified_checks: authorized,
    run_prebuilds: authorized && (has('prebuilds') || cpp || desktop || mobile),
    run_cpp_tests: cpp,
    run_desktop: desktop,
    run_mobile: mobile
  }
}

function main(env) {
  let labels = null
  try {
    labels = JSON.parse(env.PR_LABELS_JSON || 'null')
  } catch {}
  const flags = route({
    event: env.EVENT_NAME,
    labels,
    headRepo: env.HEAD_REPO,
    isDraft: env.IS_DRAFT === 'true'
  })
  console.log(`CI routing: ${OUTPUTS.map((o) => `${o}=${flags[o]}`).join(' ')}`)
  appendFileSync(env.GITHUB_OUTPUT, OUTPUTS.map((o) => `${o}=${flags[o]}\n`).join(''))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env)

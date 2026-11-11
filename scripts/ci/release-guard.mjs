#!/usr/bin/env node
// Which release PR checks pr-checks.yml's release-guard job runs, from the PR's base branch: a release train's, or a
// package's own when the base is release-<slug>-<x.y.z> and the package's publish metadata sets releaseGuard.

import { appendFileSync } from 'node:fs'

const base = process.env.BASE_REF || ''
const out = (lines) =>
  appendFileSync(process.env.GITHUB_OUTPUT, lines.map((l) => `${l}\n`).join(''))

if (base.startsWith('release-train-')) {
  out(['train=true'])
} else {
  const m = base.match(/^release-(.+)-(\d+\.\d+\.\d+)$/)
  const project = m && JSON.parse(process.env.PROJECTS || '[]').find((p) => p.slug === m[1])
  if (!m) console.log(`::notice::Base '${base}' is not release-<slug>-x.y.z; no release guard`)
  else if (!project?.releaseGuard)
    console.log(
      `::notice::'${m[1]}' sets no releaseGuard in its publish metadata; its release workflow guards it`
    )
  else out([`slug=${project.slug}`, `dir=${project.dir}`, `version=${m[2]}`])
}

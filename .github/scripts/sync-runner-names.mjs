#!/usr/bin/env node
/**
 * Regenerate .github/workflows/reusable-runner-names.yml from .github/runners.yaml.
 *
 * Does not rewrite caller workflows. After editing the catalog:
 *   node .github/scripts/sync-runner-names.mjs
 *   node --test .github/scripts/test/runner-names.test.mjs
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadRunners,
  renderReusableWorkflow,
  repoRoot,
  REUSABLE_WORKFLOW,
  RUNNERS_YAML,
} from './lib/runner-names.mjs'

const runners = loadRunners()
const rendered = renderReusableWorkflow(runners)
writeFileSync(join(repoRoot, REUSABLE_WORKFLOW), rendered, 'utf8')
console.log(`wrote ${REUSABLE_WORKFLOW} (${runners.length} labels from ${RUNNERS_YAML})`)

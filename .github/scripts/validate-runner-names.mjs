#!/usr/bin/env node
/**
 * Fail if addon workflows hardcode catalog runner labels or drift from the
 * generated reusable-runner-names workflow.
 *
 * Usage: node .github/scripts/validate-runner-names.mjs
 */
import {
  ACTIONLINT_YAML,
  REUSABLE_WORKFLOW,
  RUNNERS_YAML,
  assertReusableMatchesCatalog,
  findHardcodedLabelViolations,
  findJobsMissingNeeds,
  findMissingActionlintLabels,
  findMissingRunnerNamesNeeds,
  findRunnerNamesMissingPermissions,
  listAddonWorkflows,
  loadRunners,
  readRepoFile,
} from './lib/runner-names.mjs'

function main() {
  const runners = loadRunners()
  const errors = []

  try {
    assertReusableMatchesCatalog(runners, readRepoFile(REUSABLE_WORKFLOW))
  } catch (error) {
    errors.push(error.message)
  }

  const missingActionlint = findMissingActionlintLabels(
    runners,
    readRepoFile(ACTIONLINT_YAML),
  )
  for (const label of missingActionlint) {
    errors.push(`${ACTIONLINT_YAML} is missing self-hosted label ${label} (from ${RUNNERS_YAML})`)
  }

  for (const file of listAddonWorkflows()) {
    const source = readRepoFile(file)
    for (const finding of findHardcodedLabelViolations(file, source, runners)) {
      errors.push(
        `${finding.file}:${finding.line} hardcodes runner label ${finding.label}: ${finding.text}`,
      )
    }
    for (const finding of findMissingRunnerNamesNeeds(file, source)) {
      errors.push(`${finding.file}: ${finding.message}`)
    }
    for (const finding of findJobsMissingNeeds(file, source)) {
      errors.push(`${finding.file}: ${finding.message}`)
    }
    for (const finding of findRunnerNamesMissingPermissions(file, source)) {
      errors.push(`${finding.file}: ${finding.message}`)
    }
  }

  if (errors.length > 0) {
    console.error(`validate-runner-names: ${errors.length} finding(s):`)
    for (const error of errors) console.error(`  ${error}`)
    process.exit(1)
  }

  console.log(
    `validate-runner-names: ok (${runners.length} labels, ${listAddonWorkflows().length} addon workflows)`,
  )
}

main()

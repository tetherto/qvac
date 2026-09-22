import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../utils/config-loader.js'
import { loadTests } from '../../utils/test-loader.js'
import { testDefinitionSchema, zodStepOperations } from '../../types/test-definition.js'
import type { Step } from '../../types/test-definition.js'

/**
 * Validates every definition in the catalog before a run.
 *
 * The point is timing: a malformed step should fail here, in seconds, rather
 * than in the middle of a GPU run an hour later. It also makes the two
 * vocabularies — the step operations and the platform names — checkable rather
 * than prose, which is what turns the trade-off reviewers accepted into
 * something enforced.
 *
 * Validation runs against the Zod schema, which is the same definition the
 * framework itself parses with. `schema/test-definition.schema.json` is the
 * language-neutral copy a non-JS client reads, and this command fails when the
 * two disagree about which operations exist — the part most likely to drift,
 * and the drift a non-JS client cannot detect for itself.
 */

interface CatalogValidateOptions {
  config: string
  /** Also print the operations the vocabulary declares. */
  checkSchemaParity?: boolean
}

function schemaPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '../../../schema/test-definition.schema.json')
}

/**
 * The operation names the JSON Schema declares.
 *
 * Drift here is the realistic failure: someone adds an operation to the Zod
 * schema and the interpreter, and the language-neutral copy silently keeps
 * describing the old vocabulary — so a non-JS client generates the wrong stubs.
 */
export function schemaStepOperations(): string[] {
  const schema = JSON.parse(fs.readFileSync(schemaPath(), 'utf-8')) as {
    $defs: { step: { properties: Record<string, unknown> } }
  }
  return Object.keys(schema.$defs.step.properties).sort()
}

/** Does this body check anything, at any nesting depth? */
function assertsSomewhere(steps: Step[]): boolean {
  return steps.some((step) => {
    if ('assert' in step || 'compare' in step) return true
    if ('repeat' in step) return assertsSomewhere(step.repeat.steps)
    return false
  })
}

// lunte-disable-next-line require-await
export async function catalogValidate(options: CatalogValidateOptions) {
  try {
    const configDir = path.resolve(options.config)
    const config = await loadConfig(configDir)
    const tests = await loadTests(config, configDir)

    console.log(`📋 Validating ${tests.length} definitions...\n`)

    const failures: string[] = []
    const seen = new Set<string>()
    let withSteps = 0

    for (const test of tests) {
      const id = test.testId ?? '<missing testId>'

      if (seen.has(id)) {
        failures.push(`${id}: duplicate testId`)
      }
      seen.add(id)

      const parsed = testDefinitionSchema.safeParse(test)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          failures.push(`${id}: ${issue.path.join('.') || '(root)'} — ${issue.message}`)
        }
        continue
      }

      if (parsed.data.steps?.length) {
        withSteps++
        // A body that never asserts would report "passed" on a technicality.
        // Walked structurally rather than searched for in the serialised form,
        // where a named-assertion argument that happened to be the string
        // "assert" would satisfy the check without asserting anything.
        if (!assertsSomewhere(parsed.data.steps)) {
          failures.push(`${id}: has steps but no assert or compare step`)
        }
      }
    }

    console.log(`   ${tests.length - withSteps} executor-backed, ${withSteps} with steps`)

    // The vocabulary is written down twice: in Zod, which the framework parses
    // with, and as JSON Schema, which a client in another language reads to
    // know what exists. Two copies drift, and the realistic way is that someone
    // adds an operation to Zod and the interpreter and forgets the other copy —
    // after which that client generates the wrong stubs and reports
    // `incomplete` for something that is actually specified. The two real
    // copies are compared to each other rather than to a third list written out
    // somewhere, because a third list drifts the same way.
    const declared = zodStepOperations()
    const published = schemaStepOperations()
    const missing = declared.filter((operation) => !published.includes(operation))
    const extra = published.filter((operation) => !declared.includes(operation))

    if (missing.length > 0 || extra.length > 0) {
      failures.push(
        'schema/test-definition.schema.json and the Zod vocabulary disagree' +
          (missing.length > 0 ? ` — missing from the JSON Schema: ${missing.join(', ')}` : '') +
          (extra.length > 0 ? ` — only in the JSON Schema: ${extra.join(', ')}` : '')
      )
    }

    if (options.checkSchemaParity) {
      console.log(`   vocabulary: ${declared.length} operations — ${declared.join(', ')}`)
    }

    if (failures.length > 0) {
      console.error(`\n❌ ${failures.length} problem(s):\n`)
      for (const failure of failures) console.error(`   ${failure}`)
      process.exit(1)
    }

    console.log('\n✅ Catalog is valid')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('❌ Catalog validation failed:', message)
    process.exit(1)
  }
}

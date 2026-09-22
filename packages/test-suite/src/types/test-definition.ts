import { z } from 'zod'
import { expectationSchema } from '../schemas/expectations.js'

// Re-export for convenience
export type { Expectation } from '../schemas/expectations.js'

/**
 * Skip information for disabled tests
 */
export const skipInfoSchema = z.object({
  reason: z.string().describe('Why this test is skipped'),
  issue: z.string().optional().describe('Issue tracker reference (e.g., QVAC-8339)'),
  impact: z
    .string()
    .optional()
    .describe('Impact description (e.g., "causes 87+ tests to timeout")'),
  platforms: z
    .array(z.string())
    .optional()
    .describe('If set, skip only on these platforms (e.g., ["mobile-ios", "mobile-android"])')
})

export type SkipInfo = z.infer<typeof skipInfoSchema>

/**
 * How a step folds a streaming call into a single value.
 */
export const collectModeSchema = z.enum(['text', 'blocks', 'events', 'pcm', 'last', 'all'])

export type CollectMode = z.infer<typeof collectModeSchema>

/**
 * One operation in a declarative test body.
 *
 * A step binds its result to a name with `as`; a later step reads it back as
 * `$name`, and `$params.x` reads the test's own `params`. The vocabulary is
 * deliberately small so that a client in any language can interpret it: adding
 * an operation costs one implementation per client.
 *
 * NOT FROZEN. These operations were read off the existing TypeScript executors
 * and are expected to change while the first categories migrate. Freeze, and
 * the accompanying JSON Schema, come once two languages have run the same
 * definitions.
 */
/**
 * One operation per step, enforced the way the JSON Schema enforces it.
 *
 * Each branch is `.strict()`, so a step carrying two operations matches no
 * branch at all. Without it Zod would STRIP the second key and accept the
 * step, while the JSON Schema (`maxProperties: 1`) and every non-JS
 * interpreter reject it -- leaving the reference implementation as the one
 * silently mis-running a definition everyone else refuses. A `superRefine`
 * cannot do this job: it sees the parsed value, which has already had the
 * extra key stripped.
 */
export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    z
      .object({
        useModel: z.object({
          deps: z
            .array(z.string())
            .min(1)
            .describe('Resource keys to load, e.g. ["embeddings"] or ["llm", "embeddings"]'),
          as: z.string().optional().describe('Bind the loaded model id(s) under this name')
        })
      })
      .strict(),

    z
      .object({
        modelSource: z.object({
          dep: z.string().describe('Resource key whose model source to resolve, e.g. "llm"'),
          as: z.string().describe('Bind the source descriptor under this name')
        })
      })
      .strict(),

    z
      .object({
        asset: z.object({
          kind: z.string().describe('Asset family, e.g. "image", "audio", "text"'),
          file: z.string().describe('Asset path relative to the platform asset root'),
          form: z
            .enum(['bytes', 'path'])
            .optional()
            .describe(
              'What to bind: the contents, or a reference the SDK can open. Which one an ' +
                'API wants is part of its contract, and the path form is what a filesystem ' +
                'path on desktop and a bundled-asset URI on mobile have in common'
            ),
          as: z.string().describe('Bind the resolved asset reference under this name')
        })
      })
      .strict(),

    z
      .object({
        call: z.object({
          method: z.string().describe('SDK method name as it appears in the contract manifest'),
          params: z.record(z.any()).optional().describe('Call parameters; values may use $refs'),
          as: z.string().optional().describe('Bind the call result under this name'),
          collect: collectModeSchema.optional().describe('How to fold a streaming result')
        })
      })
      .strict(),

    z
      .object({
        callError: z.object({
          method: z.string(),
          params: z.record(z.any()).optional(),
          collect: collectModeSchema
            .optional()
            .describe(
              'Fold the streaming result before deciding it failed. A streaming call often ' +
                'rejects only once its result is awaited, so without this an error test on a ' +
                'stream would see the call resolve and report a false pass'
            ),
          as: z
            .string()
            .describe('Bind the rejection as { code, message, hasCause } under this name')
        })
      })
      .strict(),

    z
      .object({
        repeat: z.object({
          over: z.string().describe('Reference to a list, e.g. "$params.texts"'),
          as: z.string().describe('Name bound to the current item inside the nested steps'),
          collectInto: z.string().describe('Name bound to the array of per-item results'),
          steps: z.array(stepSchema)
        })
      })
      .strict(),

    z
      .object({
        project: z.object({
          from: z.string().describe('Reference to project out of, e.g. "$result"'),
          path: z.string().describe('Field path, e.g. "a.b[0].c" or "blocks[*].text"'),
          join: z.string().optional().describe('Join a projected list with this separator'),
          as: z.string()
        })
      })
      .strict(),

    z
      .object({
        assert: z.object({
          on: z.string().describe('Reference to the value being asserted'),
          use: z
            .literal('expectation')
            .optional()
            .describe("Check against the definition's own expectation"),
          named: z.string().optional().describe('Name of a shared assertion in the registry'),
          with: z
            .record(z.any())
            .optional()
            .describe(
              'Arguments for a named assertion; values may use $refs. Needed whenever a check ' +
                'compares the result against something the test set up — e.g. that the returned ' +
                'modelId is the one we just loaded'
            )
        })
      })
      .strict(),

    z
      .object({
        compare: z.object({
          left: z.string(),
          right: z.string(),
          named: z.string().describe('Name of a shared comparison in the registry')
        })
      })
      .strict()
  ])
)

export type Step =
  | { useModel: { deps: string[]; as?: string } }
  | { modelSource: { dep: string; as: string } }
  | { asset: { kind: string; file: string; form?: 'bytes' | 'path'; as: string } }
  | {
      call: {
        method: string
        params?: Record<string, unknown>
        as?: string
        collect?: CollectMode
      }
    }
  | {
      callError: {
        method: string
        params?: Record<string, unknown>
        collect?: CollectMode
        as: string
      }
    }
  | { repeat: { over: string; as: string; collectInto: string; steps: Step[] } }
  | { project: { from: string; path: string; join?: string; as: string } }
  | {
      assert: {
        on: string
        use?: 'expectation'
        named?: string
        with?: Record<string, unknown>
      }
    }
  | { compare: { left: string; right: string; named: string } }

/**
 * Test definition schema
 */
/**
 * The operations this vocabulary declares, read off the schema itself.
 *
 * Read rather than listed, because a hand-written list is a third copy of the
 * vocabulary and drifts exactly like the other two. `catalog:validate` compares
 * this against the language-neutral JSON Schema, which is the copy a client in
 * another language reads.
 */
export function zodStepOperations(): string[] {
  const lazy = stepSchema as unknown as { _def: { getter: () => { options: unknown[] } } }
  const options = lazy._def.getter().options as Array<{ shape: Record<string, unknown> }>
  return options.flatMap((option) => Object.keys(option.shape)).sort()
}

export const testDefinitionSchema = z.object({
  testId: z
    .string()
    .describe('Unique identifier for this test (e.g., "api-create-user", "completion-basic")'),

  params: z.any().describe('Parameters to pass to the test executor'),

  expectation: expectationSchema.describe('Expected outcome specification for validation'),

  metadata: z
    .record(z.any())
    .optional()
    .describe(
      'Optional metadata: setup requirements, categories, timeouts, or any repo-specific info'
    ),

  suites: z
    .array(z.string())
    .optional()
    .describe('Suite tags for grouping and filtering (e.g., ["smoke", "regression", "slow"])'),

  skip: skipInfoSchema.optional().describe('If present, test is skipped with reason logged'),

  steps: z
    .array(stepSchema)
    .optional()
    .describe(
      'Optional declarative test body. When present, a step interpreter executes the test and ' +
        'any language can run it. When absent the definition routes to its TypeScript executor ' +
        'exactly as before, so migration is per-test and reversible.'
    ),

  retryOnFailure: z
    .boolean()
    .optional()
    .describe(
      'Opt-in diagnostic reload retry. Disabled by default; when omitted or false the test ' +
        'behaves exactly as before (no retry). Set to true to enable: on failure the executor ' +
        'reload() is called and the test runs once more. The test is always reported as failed ' +
        'regardless of retry outcome — diagnostic only.'
    )
})

export type TestDefinition = z.infer<typeof testDefinitionSchema>

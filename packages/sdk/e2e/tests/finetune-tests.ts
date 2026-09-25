import type { Step, TestDefinition } from '@qvac/test-suite'

/** The LoRA adapter a completed run is asked to write. */
const ADAPTER_FILE = 'trained-lora-adapter.gguf'

/**
 * One training run over the tiny bundled datasets.
 *
 * The scratch directory is this client's, not the engine's: the test tells the
 * API where to write and then asks whether the file it was told to produce is
 * there. That is a claim about the public contract -- unlike reading the
 * engine's own storage layout, which is why `rag-turbovec-ingest-search` stays
 * on its executor.
 */
const finetuneRun = (dependency: string, checks: Step[]): Step[] => [
  { useModel: { deps: [dependency], as: 'model' } },
  { asset: { kind: 'document', file: 'finetune_train_tiny_HF.jsonl', form: 'path', as: 'train' } },
  {
    asset: { kind: 'document', file: 'finetune_eval_tiny_HF.jsonl', form: 'path', as: 'evaluate' }
  },
  {
    call: {
      method: 'scratchDirectory',
      params: { subdirectories: ['output', 'checkpoints'] },
      as: 'scratch'
    }
  },
  { project: { from: '$scratch', path: 'path', as: 'scratchPath' } },
  { project: { from: '$scratch', path: 'directories.output', as: 'outputDir' } },
  { project: { from: '$scratch', path: 'directories.checkpoints', as: 'checkpointDir' } },
  {
    call: {
      method: 'finetune',
      collect: 'events',
      params: {
        modelId: '$model',
        options: {
          trainDatasetDir: '$train',
          validation: { type: 'dataset', path: '$evaluate' },
          outputParametersDir: '$outputDir',
          checkpointSaveDir: '$checkpointDir',
          checkpointSaveSteps: 2,
          numberOfEpochs: '$params.numberOfEpochs',
          learningRate: 1e-5,
          lrMin: 1e-8,
          assistantLossOnly: true,
          loraModules: '$params.loraModules?'
        }
      },
      as: 'run'
    }
  },
  { project: { from: '$run', path: 'events', as: 'progress' } },
  { project: { from: '$run', path: 'last', as: 'result' } },
  { assert: { on: '$progress', named: 'lengthAtLeast', with: { length: 1 } } },
  { project: { from: '$result', path: 'status', as: 'status' } },
  { assert: { on: '$status', named: 'valueIn', with: { values: ['COMPLETED'] } } },
  ...checks
]

/** Removes the scratch directory, on both paths. */
const discardScratch: Step[] = [
  { call: { method: 'discardScratchDirectory', params: { path: '$scratchPath?' } } }
]

/**
 * The default `loraModules` the executor passed. Written out because the
 * catalog is data: a body cannot fall back to a constant the way a handler
 * could, and leaving it implicit would make the two runs differ.
 */
const DEFAULT_LORA_MODULES = 'attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down'

function createFinetuneTest(
  testId: string,
  params: Record<string, unknown> & { resourceKey?: string },
  estimatedDurationMs: number,
  suites?: string[],
  steps?: Step[]
): TestDefinition {
  return {
    testId,
    // `loraModules` defaults here rather than in the body, so both the
    // executor and the declarative run send the same set.
    params: { loraModules: DEFAULT_LORA_MODULES, ...params },
    expectation: { validation: 'type', expectedType: 'string' },
    ...(suites && { suites }),
    ...(steps && { steps, finally: discardScratch }),
    metadata: {
      category: 'finetune',
      dependency: params.resourceKey ?? 'finetune-llm',
      estimatedDurationMs
    }
  }
}

export const finetuneStartComplete = createFinetuneTest(
  'finetune-start-complete',
  {
    numberOfEpochs: 1
  },
  60000,
  ['smoke'],
  finetuneRun('finetune-llm', [
    { project: { from: '$result', path: 'stats.global_steps', as: 'steps' } },
    { assert: { on: '$steps', named: 'atLeast', with: { value: 1 } } },
    { assert: { on: '$progress', named: 'anyElementPositive', with: { field: 'loss' } } },
    {
      call: {
        method: 'producedFile',
        params: { directory: '$outputDir', file: ADAPTER_FILE },
        as: 'adapter'
      }
    },
    { project: { from: '$adapter', path: 'exists', as: 'adapterExists' } },
    { assert: { on: '$adapterExists', named: 'isTrue' } }
  ])
)

/**
 * Not migrated, and the reason is specific.
 *
 * The body pauses the run from inside its own progress callback, once a given
 * number of global steps has gone by, and then resumes it. `start`/`settle`
 * cannot help: the pause has to happen at a particular point *in* the stream,
 * not merely while the run is in flight, and a step cannot carry the predicate
 * that decides when that point has arrived.
 */
export const finetunePauseResume = createFinetuneTest(
  'finetune-pause-resume',
  {
    numberOfEpochs: 1,
    pauseAfterGlobalSteps: 2
  },
  90000
)

export const finetuneProgressStreaming = createFinetuneTest(
  'finetune-progress-streaming',
  {
    numberOfEpochs: 1,
    minimumProgressEvents: 1
  },
  60000,
  undefined,
  finetuneRun('finetune-llm', [
    {
      assert: {
        on: '$progress',
        named: 'lengthAtLeast',
        with: { length: '$params.minimumProgressEvents' }
      }
    }
  ])
)

/**
 * Two refusals, and the second one is the interesting half.
 *
 * An unknown model id is rejected before anything starts; a dataset path that
 * does not exist is only discovered once the run is under way, so it surfaces
 * when the result is awaited rather than when the call is made.
 */
export const finetuneErrorCases = createFinetuneTest(
  'finetune-error-cases',
  {
    invalidModelId: 'missing-finetune-model'
  },
  30000,
  undefined,
  [
    { useModel: { deps: ['finetune-llm'], as: 'model' } },
    {
      callError: {
        method: 'finetune',
        collect: 'last',
        params: { modelId: '$params.invalidModelId', operation: 'pause' },
        as: 'unknownModel'
      }
    },
    { assert: { on: '$unknownModel', named: 'errorIsStructured' } },
    {
      asset: { kind: 'document', file: 'finetune_eval_tiny_HF.jsonl', form: 'path', as: 'evaluate' }
    },
    {
      call: {
        method: 'scratchDirectory',
        params: { subdirectories: ['output', 'checkpoints'] },
        as: 'scratch'
      }
    },
    { project: { from: '$scratch', path: 'path', as: 'scratchPath' } },
    { project: { from: '$scratch', path: 'directories.output', as: 'outputDir' } },
    { project: { from: '$scratch', path: 'directories.checkpoints', as: 'checkpointDir' } },
    // A path inside this run's own scratch root, and nothing was written
    // there. Asking for it this way also states the premise: if the file did
    // exist the rejection below would be about something else.
    {
      call: {
        method: 'producedFile',
        params: { directory: '$scratchPath', file: 'missing-train.jsonl' },
        as: 'missingTrain'
      }
    },
    { project: { from: '$missingTrain', path: 'exists', as: 'missingTrainExists' } },
    { assert: { on: '$missingTrainExists', named: 'valueIn', with: { values: [false] } } },
    { project: { from: '$missingTrain', path: 'path', as: 'missingTrainPath' } },
    {
      callError: {
        method: 'finetune',
        collect: 'last',
        params: {
          modelId: '$model',
          options: {
            trainDatasetDir: '$missingTrainPath',
            validation: { type: 'dataset', path: '$evaluate' },
            outputParametersDir: '$outputDir',
            checkpointSaveDir: '$checkpointDir',
            checkpointSaveSteps: 2,
            numberOfEpochs: 1,
            learningRate: 1e-5,
            lrMin: 1e-8,
            assistantLossOnly: true,
            loraModules: '$params.loraModules'
          }
        },
        as: 'missingDataset'
      }
    },
    // The message, not the structure. The unknown-model refusal above carries
    // a code; this one carries neither a code nor a cause -- it surfaces as a
    // bare "Unable to open dataset file". Worth fixing in the SDK, but
    // asserting structure here would be failing the test for something the
    // executor never claimed.
    { project: { from: '$missingDataset', path: 'message', as: 'datasetMessage' } },
    {
      assert: {
        on: '$datasetMessage',
        named: 'containsAll',
        with: { terms: ['missing-train.jsonl'] }
      }
    }
  ]
)

export const finetuneProgressZeroDrop = createFinetuneTest(
  'finetune-progress-zero-drop',
  {
    numberOfEpochs: 2
  },
  120000,
  undefined,
  finetuneRun('finetune-llm', [{ assert: { on: '$progress', named: 'noProgressBatchGaps' } }])
)

/**
 * The progress schema parses, run after run.
 *
 * The executor counted how many losses came back as numbers, NaN or null and
 * folded the counts into a sentence it then validated as "a string" -- so the
 * only thing it could fail on was the run itself. Migrated as that plus the
 * checks it was implicitly making: the run completed and every update parsed
 * into the shape the client declares.
 */
export const finetuneProgressLossSchema = createFinetuneTest(
  'finetune-progress-loss-schema',
  { numberOfEpochs: 1 },
  60000,
  undefined,
  finetuneRun('finetune-llm', [
    {
      repeat: {
        over: '$progress',
        as: 'update',
        collectInto: 'checked',
        steps: [
          {
            assert: {
              on: '$update',
              named: 'fieldsPresent',
              with: { fields: ['current_epoch', 'current_batch', 'total_batches', 'is_train'] }
            }
          }
        ]
      }
    }
  ])
)

export const finetuneQwen35Arch = createFinetuneTest(
  'finetune-qwen35-arch',
  {
    numberOfEpochs: 1,
    resourceKey: 'finetune-llm-qwen35',
    loraModules: 'ffn_gate,ffn_down'
  },
  90000,
  undefined,
  finetuneRun('finetune-llm-qwen35', [
    {
      call: {
        method: 'producedFile',
        params: { directory: '$outputDir', file: ADAPTER_FILE },
        as: 'adapter'
      }
    },
    { project: { from: '$adapter', path: 'exists', as: 'adapterExists' } },
    { assert: { on: '$adapterExists', named: 'isTrue' } }
  ])
)

export const finetuneTests = [
  finetuneStartComplete,
  finetunePauseResume,
  finetuneProgressStreaming,
  finetuneErrorCases,
  finetuneProgressZeroDrop,
  finetuneProgressLossSchema,
  finetuneQwen35Arch
]

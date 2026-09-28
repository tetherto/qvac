import type { CanonicalModelType } from '@/schemas/index'
import {
  fetchFitStub,
  removeStub,
  type FitStubOptions,
  type FitStubRef,
  type FitStubUnavailableReason
} from '@/resources/model-fit/fit-stub/fetch-fit-stub'
import {
  runAdvisoryFitCheck,
  type AdvisoryFitOptions,
  type AdvisoryFitOutcome
} from '@/resources/model-fit/native-probe/advisory-fit'

export interface StubFitInput {
  model: FitStubRef
  modelType: CanonicalModelType
  /** The load the caller intends, in the spelling the engine's config uses. */
  modelConfig: unknown
}

export type StubFitOutcome =
  | { status: 'projected'; fit: AdvisoryFitOutcome }
  | { status: 'no-stub'; reason: FitStubUnavailableReason; message?: string }

export interface StubFitOptions {
  stub?: FitStubOptions
  fit?: AdvisoryFitOptions
}

/**
 * Projects a load from the registry's fit stub, before the weights exist
 * locally.
 *
 * The stub is an ordinary GGUF as far as the fitter is concerned, so this is
 * the same probe `loadModel` runs, pointed at a file that is tens of KB instead
 * of gigabytes. It inherits that probe's fail-open contract: every failure is
 * an `unknown` verdict or a `no-stub` outcome, never a throw.
 */
export async function projectFitFromStub(
  input: StubFitInput,
  options: StubFitOptions = {}
): Promise<StubFitOutcome> {
  const stub = await fetchFitStub(input.model, options.stub)
  if (stub.status !== 'ready') {
    return stub.message === undefined
      ? { status: 'no-stub', reason: stub.reason }
      : { status: 'no-stub', reason: stub.reason, message: stub.message }
  }

  try {
    const fit = await runAdvisoryFitCheck(
      {
        modelId: input.model.name,
        modelType: input.modelType,
        modelPath: stub.path,
        modelConfig: input.modelConfig,
        // One stub is one artifact: `fetchFitStub` does not assemble a shard set,
        // so nothing here may claim the fitter is looking at a split model.
        isShardedModel: false
      },
      options.fit
    )

    return { status: 'projected', fit }
  } finally {
    // The stub is a per-call payload. Nothing else knows the path, so nothing
    // else could remove it.
    await removeStub(stub.path)
  }
}

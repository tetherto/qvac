import {
  resolveLoadFromStubs,
  type LoadDescription
} from '@/resources/model-fit/fit-stub/resolve-load-from-stubs'
import type {
  FitStubOptions,
  FitStubUnavailableReason
} from '@/resources/model-fit/fit-stub/fetch-fit-stub'
import {
  runAdvisoryFitCheck,
  type AdvisoryFitOptions,
  type AdvisoryFitOutcome
} from '@/resources/model-fit/native-probe/advisory-fit'

export type LoadFitOutcome =
  | { status: 'projected'; fit: AdvisoryFitOutcome }
  | { status: 'no-stub'; reason: FitStubUnavailableReason; message?: string }
  | { status: 'unsupported-load'; detail: string }

export interface LoadFitOptions {
  stub?: FitStubOptions
  fit?: AdvisoryFitOptions
}

/**
 * Projects the load a caller describes, before its weights exist locally.
 *
 * The same probe `loadModel` runs, over the same config and artifacts that
 * load's own plugin resolves, pointed at files that are tens of KB instead of
 * gigabytes. It inherits the probe's fail-open contract: every failure is an
 * `unknown` verdict or a non-projected outcome, never a throw.
 */
export async function projectFitFromLoad(
  load: LoadDescription,
  modelId: string,
  options: LoadFitOptions = {}
): Promise<LoadFitOutcome> {
  const resolved = await resolveLoadFromStubs(load, options.stub)
  if (resolved.status !== 'resolved') return resolved

  try {
    const fit = await runAdvisoryFitCheck(
      {
        modelId,
        modelType: load.modelType,
        modelPath: resolved.modelPath,
        modelConfig: resolved.modelConfig,
        artifacts: resolved.artifacts,
        // Nothing here assembles a shard set, so no load may claim the fitter
        // is looking at a split model.
        isShardedModel: false
      },
      options.fit
    )

    return { status: 'projected', fit }
  } finally {
    await resolved.release()
  }
}

// `@qvac/sdk/model-fit-calibration` subpath. The harness lives in
// @qvac/inference; the SDK re-exports it so a worker-side plugin (the e2e
// consumer's calibration plugin) reaches the engine's own copy instead of
// resolving @qvac/inference itself and risking a second instance.
export * from '@qvac/inference/model-fit-calibration'

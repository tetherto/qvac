export type SourceProfile = 'auxiliary' | 'production'

export interface ThresholdPair {
  readonly advisory: number
  readonly high: number
}

export interface StructureThresholds {
  readonly fileLines: ThresholdPair
  readonly functionLines: ThresholdPair
  readonly modifiedComplexity: ThresholdPair
  readonly nestingDepth: ThresholdPair
}

export const STRUCTURE_THRESHOLDS: Readonly<
  Record<SourceProfile, StructureThresholds>
> = {
  production: {
    fileLines: { advisory: 300, high: 500 },
    functionLines: { advisory: 50, high: 100 },
    modifiedComplexity: { advisory: 15, high: 25 },
    nestingDepth: { advisory: 4, high: 6 },
  },
  auxiliary: {
    fileLines: { advisory: 600, high: 1000 },
    functionLines: { advisory: 100, high: 200 },
    modifiedComplexity: { advisory: 20, high: 35 },
    nestingDepth: { advisory: 5, high: 7 },
  },
}

export const FAN_OUT_THRESHOLDS: Readonly<
  Record<SourceProfile, ThresholdPair>
> = {
  production: { advisory: 20, high: 30 },
  auxiliary: { advisory: 25, high: 40 },
}

export interface UnresolvedImportExemption {
  readonly importer: RegExp
  readonly specifier: RegExp
  readonly reason: string
}

export const UNRESOLVED_IMPORT_EXEMPTIONS: readonly UnresolvedImportExemption[] = [
  {
    importer: /^packages\/(?:asr-ggml|audiogen-ggml|bci-whispercpp|classification-ggml|diffusion-cpp|embed-llamacpp|llm-llamacpp|model-fit|ocr-ggml|translation-nmtcpp|tts-ggml|vla-ggml)\/src\//,
    specifier: /^(?:\.\.\/)*(?:\.\/)?binding(?:-internal)?(?:\.js)?$/,
    reason: 'Native addon bindings are resolved after TypeScript output is moved to the package root.',
  },
  {
    importer: /^packages\/(?:asr-ggml|audiogen-ggml|bci-whispercpp|decoder-audio|ocr-ggml|translation-nmtcpp|tts-ggml|vla-ggml)\/src\//,
    specifier: /^(?:\.\.\/)*(?:\.\/)?package\.json$/,
    reason: 'Package manifest imports resolve after compiled sources are relocated beside the package manifest.',
  },
  {
    importer: /^packages\/(?:asr-ggml|ocr-ggml)\/test\/integration\/.*run-with-exit\.js$/,
    specifier: /^\.\/all\.js$/,
    reason: 'The integration test aggregator is generated immediately before the test run.',
  },
  {
    importer: /^packages\/inference\/scripts\/calibrate-model-fit\.ts$/,
    specifier: /^\.\.\/dist\//,
    reason: 'The calibration script intentionally exercises the compiled package output.',
  },
  {
    importer: /^packages\/test-suite\/test\/unit\/build-consumer-mobile\.test\.js$/,
    specifier: /^\.\.\/\.\.\/dist\//,
    reason: 'This unit test intentionally loads compiled CLI output.',
  },
  {
    importer: /^packages\/sdk\/e2e\/tests\/mobile\//,
    specifier: /^(?:\.\.\/)+(?:assets|consumer-config)$/,
    reason: 'Mobile asset and consumer configuration modules are generated during consumer assembly.',
  },
  {
    importer: /^packages\/test-suite\/templates\/mobile-consumer\/consumer-wrapper\.tsx$/,
    specifier: /^\.\/(?:consumer-config|executor|proc-mem-worklet\.bundle\.mjs|test-definitions)$/,
    reason: 'Consumer template companions are generated or injected when the template is materialized.',
  },
  {
    importer: /^packages\/sdk\/src\/client\/rpc\/rpc-client\.ts$/,
    specifier: /^#rpc$/,
    reason: 'The package import map selects a platform-specific compiled RPC implementation.',
  },
  {
    importer: /^packages\/translation-nmtcpp\/src\/index\.ts$/,
    specifier: /^\.\/third-party\/indic-processor$/,
    reason: 'The compiled entry point is emitted beside the vendored third-party directory.',
  },
]

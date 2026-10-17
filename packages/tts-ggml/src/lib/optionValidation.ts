/**
 * Constructor-time option validation, in the order the errors are reported:
 * streaming capability, Parler, sampler and engine-scoped options, then each
 * engine's own consistency rules, cross-engine conditioning, and finally the
 * denoiser's batch-only rule.
 */
import { assertConditioningConsistency } from "./conditioning";
import {
  ENGINE_CHATTERBOX,
  ENGINE_COSYVOICE3,
  ENGINE_POCKET,
  ENGINE_SUPERTONIC,
  SAMPLING_ENGINES,
  type EngineType,
} from "./engineIds";
import type { EngineSetup } from "./engineSetup";
import { assertAudio8Options } from "./engines/audio8";
import {
  assertCosyvoiceCloneConsistent,
  assertCosyvoiceOptionConsistency,
} from "./engines/cosyvoice";
import { assertMossOptions } from "./engines/moss";
import { assertMossSoundEffectOptions } from "./engines/mossSoundEffect";
import { assertMossSpeechOptions } from "./engines/mossSpeech";
import { assertParlerOptions } from "./engines/parler";
import { setOptionNames } from "./options";
import {
  assertChunkStreamingSupport,
  assertDenoiserBatchOnly,
} from "./streamingSupport";

export function validateEngineOptions(setup: EngineSetup): void {
  assertChunkStreamingSupport(setup);
  // Runs before the denoiser guard so a Parler description/template conflict
  // is reported ahead of the engine-agnostic streaming constraints.
  assertParlerOptions(setup);
  assertSamplerOptionSupport(setup);
  assertEngineScopedOptions(setup);
  assertCosyvoiceOptionConsistency(setup);
  assertCosyvoiceCloneConsistent(setup);
  assertAudio8Options(setup);
  assertMossOptions(setup);
  assertMossSoundEffectOptions(setup);
  assertMossSpeechOptions(setup);
  assertConditioningConsistency(setup, "constructor");
  assertDenoiserBatchOnly(setup);
}

function assertSamplerOptionSupport(setup: EngineSetup): void {
  if (setup.engineType === ENGINE_POCKET || SAMPLING_ENGINES.includes(setup.engineType)) return;
  // Chatterbox's T3 samples too, but its length cap is nPredict, not maxFrames.
  const tokenSampling =
    setup.engineType === ENGINE_CHATTERBOX
      ? {}
      : {
          temperature: setup.settings.temperature,
          topK: setup.settings.topK,
          topP: setup.settings.topP,
        };
  const sampling = setOptionNames({
    ...tokenSampling,
    maxFrames: setup.settings.maxFrames,
  });
  if (sampling.length === 0) return;
  throw new Error(
    `tts-ggml: ${sampling.join(", ")} are parler/audio8-only options ` +
      `(engine is ${setup.engineType})`,
  );
}

/**
 * Options only some engines read. Set on any other engine they would be
 * dropped without effect, so they are rejected by name instead.
 */
function assertEngineScopedOptions(setup: EngineSetup): void {
  const scoped: Array<
    [
      readonly EngineType[],
      Record<string, string | number | boolean | undefined>,
    ]
  > = [
    [
      [ENGINE_CHATTERBOX],
      {
        batchCfmSteps: setup.settings.batchCfmSteps,
        nPredict: setup.settings.nPredict,
        maxSentenceChars: setup.settings.maxSentenceChars,
        crossfadeMs: setup.settings.crossfadeMs,
        repeatPenalty: setup.settings.repeatPenalty,
        exaggeration: setup.settings.exaggeration,
        cfgWeight: setup.settings.cfgWeight,
        minP: setup.settings.minP,
      },
    ],
    [
      [ENGINE_CHATTERBOX, ENGINE_COSYVOICE3],
      { streamLeftContextTokens: setup.settings.streamLeftContextTokens },
    ],
    [
      [ENGINE_SUPERTONIC],
      {
        voiceJsonPath: setup.settings.voiceJsonPath,
        prewarmText: setup.settings.prewarmText,
        streamChunkTolerancePct: setup.settings.streamChunkTolerancePct,
        streamMinChunkTokens: setup.settings.streamMinChunkTokens,
      },
    ],
    [
      [ENGINE_SUPERTONIC, ENGINE_COSYVOICE3],
      { vulkanDevice: setup.settings.vulkanDevice },
    ],
    [[ENGINE_COSYVOICE3], { flowCutPrompt: setup.settings.flowCutPrompt }],
  ];
  for (const [engines, fields] of scoped) {
    if (engines.includes(setup.engineType)) continue;
    const names = setOptionNames(fields);
    if (names.length === 0) continue;
    throw new Error(
      `tts-ggml: ${names.join(", ")} are ${engines.join("/")}-only ` +
        `options (engine is ${setup.engineType})`,
    );
  }
}

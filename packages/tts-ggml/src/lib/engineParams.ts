import type { TTSConfigurationParams } from "../tts";
import {
  ENGINE_AUDIO8,
  ENGINE_COSYVOICE3,
  ENGINE_MOSS,
  ENGINE_MOSS_SFX,
  ENGINE_MOSS_SPEECH,
  ENGINE_PARLER,
  ENGINE_SUPERTONIC,
} from "./engineIds";
import type { EngineSetup } from "./engineSetup";
import { buildAudio8Params } from "./engines/audio8";
import { buildChatterboxParams } from "./engines/chatterbox";
import { buildCosyvoiceParams } from "./engines/cosyvoice";
import { buildMossParams } from "./engines/moss";
import { buildMossSoundEffectParams } from "./engines/mossSoundEffect";
import { buildMossSpeechParams } from "./engines/mossSpeech";
import { buildParlerParams } from "./engines/parler";
import { buildSupertonicParams } from "./engines/supertonic";
import { assignFabricOptions } from "./fabricOptions";

export function buildNativeParams(setup: EngineSetup): TTSConfigurationParams {
  const parameters = buildEngineParams(setup);
  assignFabricOptions(setup.settings, parameters);
  if (setup.config.backend !== undefined) parameters.backend = setup.config.backend;
  if (setup.engineType === ENGINE_MOSS && setup.settings.nCtx !== undefined) {
    parameters.nCtx = setup.settings.nCtx;
  }
  if (setup.engineType === ENGINE_COSYVOICE3 && setup.settings.greedy !== undefined) {
    parameters.greedy = setup.settings.greedy;
  }
  return parameters;
}

function buildEngineParams(setup: EngineSetup): TTSConfigurationParams {
  if (setup.pocket) return { ...setup.pocket.params };
  switch (setup.engineType) {
    case ENGINE_SUPERTONIC:
      return buildSupertonicParams(setup);
    case ENGINE_COSYVOICE3:
      return buildCosyvoiceParams(setup);
    case ENGINE_PARLER:
      return buildParlerParams(setup);
    case ENGINE_AUDIO8:
      return buildAudio8Params(setup);
    case ENGINE_MOSS:
      return buildMossParams(setup);
    case ENGINE_MOSS_SFX:
      return buildMossSoundEffectParams(setup);
    case ENGINE_MOSS_SPEECH:
      return buildMossSpeechParams(setup);
    default:
      return buildChatterboxParams(setup);
  }
}

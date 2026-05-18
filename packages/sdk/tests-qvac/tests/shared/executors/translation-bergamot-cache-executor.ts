import {
  loadModel,
  unloadModel,
  BERGAMOT_FR_EN,
  BERGAMOT_EN_FR,
} from "@qvac/sdk";
import {
  BaseExecutor,
  type TestResult,
} from "@tetherto/qvac-test-suite";
import { translationBergamotCacheTests } from "../../translation-bergamot-cache-tests.js";

interface BergamotCacheParams {
  pair: string;
}

interface ProgressEvent {
  downloaded: number;
  total: number;
  percentage: number;
  downloadKey: string;
}

const PAIRS = {
  "fr-en": { descriptor: BERGAMOT_FR_EN, from: "fr", to: "en" },
  "en-fr": { descriptor: BERGAMOT_EN_FR, from: "en", to: "fr" },
} as const;

type Pair = (typeof PAIRS)[keyof typeof PAIRS];

async function loadAndUnload(
  pair: Pair,
  onProgress?: (p: ProgressEvent) => void,
): Promise<void> {
  const id = await loadModel({
    modelSrc: pair.descriptor as never,
    modelType: "nmt",
    modelConfig: { engine: "Bergamot", from: pair.from, to: pair.to },
    ...(onProgress && { onProgress }),
  });
  await unloadModel({ modelId: id });
}

function summarizePartials(events: ProgressEvent[]) {
  const partials = events.filter((e) => e.total > 0 && e.downloaded < e.total);
  return { partials, touchedKeys: new Set(partials.map((e) => e.downloadKey)) };
}

export class TranslationBergamotCacheExecutor extends BaseExecutor<
  typeof translationBergamotCacheTests
> {
  pattern = /^translation-bergamot-.+-cache-reload$/;

  protected handlers = Object.fromEntries(
    translationBergamotCacheTests.map((t) => [t.testId, this.run.bind(this)]),
  ) as never;

  // Round 1 warms the cache; Round 2 must be a pure cache hit. We detect
  // re-downloads cross-platform via onProgress: a true cache hit emits at
  // most one final 100% event per file, while a real download emits many
  // partial-percentage events.
  async run(params: BergamotCacheParams): Promise<TestResult> {
    const pair = PAIRS[params.pair as keyof typeof PAIRS];
    if (!pair) {
      return { passed: false, output: `Unknown pair "${params.pair}"` };
    }

    try {
      await loadAndUnload(pair);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Round 1 (warm cache) failed: ${msg}` };
    }

    const round2: ProgressEvent[] = [];
    try {
      await loadAndUnload(pair, (p) => round2.push(p));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Round 2 (cache hit) failed: ${msg}` };
    }

    const { partials, touchedKeys } = summarizePartials(round2);
    if (touchedKeys.size > 0) {
      const sample = partials
        .slice(0, 3)
        .map((e) => `${e.downloadKey}@${e.percentage.toFixed(0)}%`)
        .join(", ");
      return {
        passed: false,
        output: `Cache invalidation regression: Round 2 re-downloaded ${touchedKeys.size} file(s), ${partials.length} partial events. First: ${sample}`,
      };
    }

    return {
      passed: true,
      output: `Cache hit on Round 2 — ${round2.length} cache-hit notification(s), no partial downloads`,
    };
  }
}

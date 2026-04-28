/**
 * Load/unload memory leak probe.
 *
 * Loads a target model, runs a tiny inference (optional), unloads it, then
 * reports RSS / external / heap before and after each cycle. Repeats N times
 * so any per-cycle drift becomes visible. Produces:
 *
 *   - Per-cycle delta:            (after_unload - before_load)
 *   - Across-suite drift:         (final after_unload - first before_load)
 *   - Peak in-cycle memory
 *
 * If `--expose-gc` is passed to node/bun, a forced GC runs between cycles
 * for tighter numbers; the script also tolerates running without it.
 *
 * Usage:
 *   bun run examples/memory-load-unload-loop.ts --target=chatterbox --cycles=5
 *   bun run examples/memory-load-unload-loop.ts --target=supertonic --cycles=10 --inference
 *   bun run examples/memory-load-unload-loop.ts --target=ocr --cycles=8
 *   bun run examples/memory-load-unload-loop.ts --target=vision --cycles=4
 *
 * Targets: chatterbox | supertonic | ocr | vision
 */
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadModel, unloadModel, completion } from "..";
import {
  TTS_TOKENIZER_EN_CHATTERBOX,
  TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32,
  TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32,
  TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32,
  TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32,
  TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32,
  TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE,
  TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE,
  OCR_LATIN_RECOGNIZER_1,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  WHISPER_TINY,
} from "@/models/registry";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REFERENCE_AUDIO = path.resolve(__dirname, "audio/sample-16khz.wav");

type Target = "chatterbox" | "supertonic" | "ocr" | "vision";

interface Args {
  target: Target;
  cycles: number;
  runInference: boolean;
  settleMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const flag = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!flag) return undefined;
    if (flag === `--${name}`) return "true";
    return flag.split("=", 2)[1];
  };
  const target = (get("target") ?? "chatterbox") as Target;
  if (!["chatterbox", "supertonic", "ocr", "vision"].includes(target)) {
    throw new Error(`Unknown --target=${target}. Use chatterbox | supertonic | ocr | vision.`);
  }
  return {
    target,
    cycles: Math.max(1, parseInt(get("cycles") ?? "5", 10)),
    runInference: get("inference") === "true",
    settleMs: Math.max(0, parseInt(get("settle-ms") ?? "1000", 10)),
  };
}

interface MemSnapshot {
  /** Sum of RSS across this process and all descendants (KiB → MB). */
  rssMb: number;
  /** This process JS heap. */
  heapUsedMb: number;
  /** This process external (Buffer / native) memory. */
  externalMb: number;
  /** PIDs included in the RSS sum, for diagnostics. */
  pids: number[];
}

function descendantPids(rootPid: number): number[] {
  // ps -A -o pid,ppid; build pid → children map; BFS from rootPid.
  let raw: string;
  try {
    raw = execSync("ps -A -o pid=,ppid=", { encoding: "utf8", timeout: 3000 });
  } catch {
    return [rootPid];
  }
  const children = new Map<number, number[]>();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const result: number[] = [rootPid];
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const p = queue.shift()!;
    for (const c of children.get(p) ?? []) {
      result.push(c);
      queue.push(c);
    }
  }
  return result;
}

function rssSumKb(pids: number[]): number {
  if (pids.length === 0) return 0;
  try {
    const out = execSync(`ps -o rss= -p ${pids.join(",")}`, {
      encoding: "utf8",
      timeout: 3000,
    });
    return out
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

function snapshot(): MemSnapshot {
  const m = process.memoryUsage();
  const pids = descendantPids(process.pid);
  const totalRssKb = rssSumKb(pids);
  return {
    rssMb: totalRssKb / 1024,
    heapUsedMb: m.heapUsed / 1024 / 1024,
    externalMb: m.external / 1024 / 1024,
    pids,
  };
}

async function settle(ms: number): Promise<void> {
  // Best-effort: force GC if exposed, then wait for native deallocators.
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
  await new Promise((r) => setTimeout(r, ms));
  if (typeof gc === "function") gc();
}

interface TargetSpec {
  description: string;
  load: () => Promise<string>;
  inference?: (modelId: string) => Promise<void>;
}

function buildSpec(target: Target): TargetSpec {
  switch (target) {
    case "chatterbox":
      return {
        description: "ONNX TTS — Chatterbox EN",
        async load() {
          return await loadModel({
            modelSrc: TTS_TOKENIZER_EN_CHATTERBOX,
            modelType: "tts",
            modelConfig: {
              ttsEngine: "chatterbox",
              language: "en",
              ttsTokenizerSrc: TTS_TOKENIZER_EN_CHATTERBOX,
              ttsSpeechEncoderSrc: TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32,
              ttsEmbedTokensSrc: TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32,
              ttsConditionalDecoderSrc: TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32,
              ttsLanguageModelSrc: TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32,
              referenceAudioSrc: REFERENCE_AUDIO,
            },
          });
        },
        // Inference deliberately omitted: load/unload of the ONNX session is
        // enough to expose addon-level allocation that survives unload.
      };

    case "supertonic":
      return {
        description: "ONNX TTS — Supertonic EN",
        async load() {
          return await loadModel({
            modelSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
            modelType: "onnx-tts",
            modelConfig: {
              ttsEngine: "supertonic",
              language: "en",
              ttsTextEncoderSrc: TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32,
              ttsDurationPredictorSrc: TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32,
              ttsVectorEstimatorSrc: TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32,
              ttsVocoderSrc: TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32,
              ttsUnicodeIndexerSrc: TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32,
              ttsTtsConfigSrc: TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE,
              ttsVoiceStyleSrc: TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE,
            },
          });
        },
      };

    case "ocr":
      return {
        description: "OCR — Latin recognizer (ONNX)",
        async load() {
          return await loadModel({
            modelSrc: OCR_LATIN_RECOGNIZER_1,
            modelType: "ocr",
            modelConfig: { langList: ["en"] },
          });
        },
        // OCR requires an image; skipping inference avoids needing fixture
        // assets here. The leak target is load+unload itself.
      };

    case "vision":
      return {
        description: "Vision — SmolVLM2 500M Q8 (LLM + projection)",
        async load() {
          return await loadModel({
            modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
            modelType: "llm",
            modelConfig: {
              ctx_size: 1024,
              projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
            },
          });
        },
        async inference(modelId) {
          // Text-only completion exercises the LLM path without needing an
          // image fixture; mmproj memory still gets allocated via load.
          for await (const _ of completion({
            modelId,
            history: [{ role: "user", content: "Hi" }],
          }).tokenStream) {
            // discard
          }
        },
      };
  }
}

function fmt(n: number): string {
  return n.toFixed(1).padStart(7);
}

function logRow(cycle: number | string, phase: string, snap: MemSnapshot, deltaFromBefore: number | null) {
  const delta = deltaFromBefore !== null ? `${deltaFromBefore >= 0 ? "+" : ""}${deltaFromBefore.toFixed(1)}` : "";
  console.log(
    `  ${String(cycle).padStart(3)}  ${phase.padEnd(14)}  rss=${fmt(snap.rssMb)} MB  heap=${fmt(snap.heapUsedMb)} MB  external=${fmt(snap.externalMb)} MB  ${delta ? `Δrss=${delta} MB` : ""}`,
  );
}

async function loadAnchor(): Promise<string> {
  // Tiny whisper (~75 MB) keeps the registry non-empty so the SDK does not
  // auto-close the RPC + Bare worker when the target is unloaded. Mirrors
  // how tests-qvac keeps the consumer alive across many tests.
  return await loadModel({
    modelSrc: WHISPER_TINY,
    modelType: "whisper",
  });
}

async function main() {
  const args = parseArgs();
  const spec = buildSpec(args.target);

  console.log("=== Memory load/unload loop ===");
  console.log(`Target:     ${spec.description}`);
  console.log(`Cycles:     ${args.cycles}`);
  console.log(`Inference:  ${args.runInference ? "yes" : "no"}`);
  console.log(`Settle:     ${args.settleMs} ms after each unload`);
  const gcAvailable = typeof (globalThis as { gc?: () => void }).gc === "function";
  console.log(`GC:         ${gcAvailable ? "exposed (--expose-gc)" : "not exposed; pass --expose-gc to node/bun for tighter numbers"}`);
  console.log("");

  // Anchor model: stays loaded for the duration of the probe so the SDK
  // doesn't tear down the Bare worker when the target is unloaded. With
  // the worker alive across cycles, what we measure IS the addon-level
  // unload behavior (does ORT/CoreML actually return the model bytes).
  console.log("Loading anchor (whisper-tiny) to keep Bare worker alive across cycles...");
  const anchorId = await loadAnchor();

  // Settle once after the anchor lands so the baseline is post-worker-spawn.
  await settle(args.settleMs);
  const baseline = snapshot();
  console.log("Baseline (anchor loaded, target not yet loaded):");
  logRow("-", "baseline", baseline, null);
  console.log("");

  const perCycleDeltas: number[] = [];
  let peakRss = baseline.rssMb;

  for (let i = 1; i <= args.cycles; i++) {
    const before = snapshot();
    logRow(i, "before-load", before, before.rssMb - baseline.rssMb);

    const modelId = await spec.load();
    const afterLoad = snapshot();
    logRow(i, "after-load", afterLoad, afterLoad.rssMb - before.rssMb);
    if (afterLoad.rssMb > peakRss) peakRss = afterLoad.rssMb;

    if (args.runInference && spec.inference) {
      await spec.inference(modelId);
      const afterInf = snapshot();
      logRow(i, "after-inference", afterInf, afterInf.rssMb - afterLoad.rssMb);
      if (afterInf.rssMb > peakRss) peakRss = afterInf.rssMb;
    }

    await unloadModel({ modelId });
    await settle(args.settleMs);
    const afterUnload = snapshot();
    const cycleDelta = afterUnload.rssMb - before.rssMb;
    perCycleDeltas.push(cycleDelta);
    logRow(i, "after-unload", afterUnload, cycleDelta);
    console.log("");
  }

  const final = snapshot();
  const totalDrift = final.rssMb - baseline.rssMb;
  const avgPerCycleDelta =
    perCycleDeltas.reduce((a, b) => a + b, 0) / perCycleDeltas.length;

  console.log("=== Summary ===");
  console.log(`Baseline RSS:                 ${fmt(baseline.rssMb)} MB`);
  console.log(`Final RSS:                    ${fmt(final.rssMb)} MB`);
  console.log(`Total drift across run:       ${(totalDrift >= 0 ? "+" : "") + totalDrift.toFixed(1)} MB`);
  console.log(`Peak RSS during run:          ${fmt(peakRss)} MB`);
  console.log(`Per-cycle Δ (after-unload − before-load):`);
  perCycleDeltas.forEach((d, i) => {
    console.log(`  cycle ${i + 1}: ${(d >= 0 ? "+" : "") + d.toFixed(1)} MB`);
  });
  console.log(`Avg per-cycle Δ:              ${(avgPerCycleDelta >= 0 ? "+" : "") + avgPerCycleDelta.toFixed(1)} MB`);
  console.log("");
  if (totalDrift > 50) {
    console.log("⚠️  Large positive drift suggests memory is not fully released by unload.");
  } else if (Math.abs(totalDrift) < 20) {
    console.log("✅ Drift within ~20 MB; load/unload appears to round-trip cleanly.");
  } else {
    console.log("ℹ️  Moderate drift — might be allocator slack rather than a hard leak. Try more cycles.");
  }

  // Unload anchor last — this triggers the SDK's auto-close (registry now
  // empty) and the process exits cleanly.
  await unloadModel({ modelId: anchorId });
}

main().catch((err) => {
  console.error("\n❌ Probe failed:", err);
  process.exit(1);
});

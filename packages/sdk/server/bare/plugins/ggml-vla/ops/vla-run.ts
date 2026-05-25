import { getModel } from "@/server/bare/registry/model-registry";
import {
  type VlaRunRequest,
  type VlaRunResponse,
  type VlaStats,
} from "@/schemas";
import { decodeBase64, encodeBase64 } from "@/utils/encoding";

interface VlaRunNative {
  await(): Promise<{
    actions: Float32Array;
    stats?: Record<string, number>;
  }>;
  cancel(): Promise<void>;
}

interface VlaModelLike {
  run(input: {
    images: Float32Array[];
    imgWidth: number;
    imgHeight: number;
    state: Float32Array;
    tokens: Int32Array;
    mask: Uint8Array;
    noise?: Float32Array;
  }): Promise<VlaRunNative>;
  hparams: { actionDim: number; chunkSize: number } | null;
}

function f32FromBase64(b64: string): Float32Array {
  const bytes = decodeBase64(b64);
  // ArrayBuffer view must be aligned; copy if needed.
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return new Float32Array(bytes.buffer);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

function i32FromBase64(b64: string): Int32Array {
  const bytes = decodeBase64(b64);
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return new Int32Array(bytes.buffer);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Int32Array(copy.buffer);
}

function u8FromBase64(b64: string): Uint8Array {
  return decodeBase64(b64);
}

function f32ToBase64(arr: Float32Array): string {
  return encodeBase64(
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
  );
}

function pickStats(raw: unknown): VlaStats | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: VlaStats = {};
  if (typeof r["vision_ms"] === "number") out.vision_ms = r["vision_ms"];
  if (typeof r["smollm2_compute_ms"] === "number")
    out.smollm2_compute_ms = r["smollm2_compute_ms"];
  if (typeof r["smollm2_total_ms"] === "number")
    out.smollm2_total_ms = r["smollm2_total_ms"];
  if (typeof r["ode_ms"] === "number") out.ode_ms = r["ode_ms"];
  if (typeof r["total_ms"] === "number") out.total_ms = r["total_ms"];
  if (typeof r["backendDevice"] === "number")
    out.backendDevice = r["backendDevice"];
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function vlaRun(request: VlaRunRequest): Promise<VlaRunResponse> {
  const model = getModel(request.modelId) as unknown as VlaModelLike;

  const images = request.images.map(f32FromBase64);
  const state = f32FromBase64(request.state);
  const tokens = i32FromBase64(request.tokens);
  const mask = u8FromBase64(request.mask);
  const noise = request.noise ? f32FromBase64(request.noise) : undefined;

  const response = await model.run({
    images,
    imgWidth: request.imgWidth,
    imgHeight: request.imgHeight,
    state,
    tokens,
    mask,
    ...(noise && { noise }),
  });

  const result = await response.await();
  const hp = model.hparams;
  if (!hp) {
    throw new Error("VLA model hparams unavailable after run");
  }

  return {
    actions: f32ToBase64(result.actions),
    actionDim: hp.actionDim,
    chunkSize: hp.chunkSize,
    ...(pickStats(result.stats) && { stats: pickStats(result.stats)! }),
  };
}

import test from "brittle";
import { transcribeStatsSchema } from "@/schemas/transcription";

test("transcribeStatsSchema: round-trips whisper backend/GPU stats", (t) => {
  const result = transcribeStatsSchema.parse({
    realTimeFactor: 0.25,
    tokensPerSecond: 120,
    backendDevice: 1,
    backendId: 3,
    gpuMemTotalMb: 8192,
    gpuMemFreeMb: 4096,
  });
  t.is(result.backendDevice, 1);
  t.is(result.backendId, 3);
  t.is(result.gpuMemTotalMb, 8192);
  t.is(result.gpuMemFreeMb, 4096);
});

test("transcribeStatsSchema: backend/GPU fields are optional (CPU / parakeet path)", (t) => {
  const result = transcribeStatsSchema.parse({ realTimeFactor: 1.5 });
  t.absent(result.backendDevice);
  t.absent(result.backendId);
  t.absent(result.gpuMemTotalMb);
  t.absent(result.gpuMemFreeMb);
});

test("transcribeStatsSchema: accepts the -1 no-accounting sentinel for gpu memory", (t) => {
  const result = transcribeStatsSchema.parse({
    backendDevice: 1,
    backendId: 2,
    gpuMemTotalMb: -1,
    gpuMemFreeMb: -1,
  });
  t.is(result.gpuMemTotalMb, -1);
  t.is(result.gpuMemFreeMb, -1);
});

test("transcribeStatsSchema: rejects non-numeric backend fields", (t) => {
  t.exception(() =>
    transcribeStatsSchema.parse({ backendId: "vulkan" }),
  );
});

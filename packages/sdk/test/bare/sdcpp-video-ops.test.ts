import test from "brittle";
import { VideoStableDiffusion } from "@qvac/diffusion-cpp";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg==";
const JPEG_B64 = "/9j/4AAQSkZJRgABAQEASABIAAA=";

let idCounter = 0;
function makeId(prefix: string): string {
  idCounter++;
  return `${prefix}-${idCounter}-${Date.now()}`;
}

async function withRegisteredVideoModel<T>(
  runImpl: (params: unknown) => Promise<unknown>,
  body: (modelId: string) => Promise<T>,
  cancelImpl: () => Promise<void> = async function () {},
) {
  const [{ registerModel, unregisterModel }, { ModelType }] = await Promise.all(
    [import("@/server/bare/registry/model-registry"), import("@/schemas")],
  );
  const modelId = makeId("test-video");
  const fakeModel = Object.create(VideoStableDiffusion.prototype) as Record<string, unknown>;
  fakeModel["load"] = async function () {};
  fakeModel["run"] = runImpl;
  fakeModel["cancel"] = cancelImpl;

  try {
    registerModel(modelId, {
      model: fakeModel as never,
      path: "/tmp/video-model.safetensors",
      config: {},
      modelType: ModelType.sdcppGeneration,
    } as never);
    return await body(modelId);
  } finally {
    unregisterModel(modelId);
  }
}

test(
  "video op: decodes base64 inputs, forwards mode, and emits stream responses",
  async function (t) {
    const { video: videoOp } =
      await import("@/server/bare/plugins/sdcpp-generation/ops/video");
    let observed: Record<string, unknown> | undefined;

    await withRegisteredVideoModel(
      async function (params: unknown) {
        observed = params as Record<string, unknown>;
        return {
          stats: {
            generationMs: 900,
            totalVideos: 1,
            totalVideoFrames: 5,
            videoFrames: 5,
            fps: 16,
          },
          iterate: async function* () {
            yield JSON.stringify({ step: 2, total: 5, elapsed_ms: 250 });
            yield new Uint8Array([82, 73, 70, 70]);
          },
        };
      },
      async (modelId) => {
        const chunks = [];
        for await (const chunk of videoOp({
          modelId,
          mode: "txt2vid",
          prompt: "a running fox",
          control_frames: [PNG_B64, JPEG_B64],
          video_frames: 5,
          fps: 16,
        })) {
          chunks.push(chunk);
        }

        t.ok(observed, "model.run was called");
        t.is(observed?.["mode"], "txt2vid");
        t.ok(Array.isArray(observed?.["control_frames"]));
        t.is((observed?.["control_frames"] as Uint8Array[]).length, 2);

        t.alike(chunks[0], {
          type: "videoStream",
          step: 2,
          totalSteps: 5,
          elapsedMs: 250,
        });
        t.is(chunks[1]?.type, "videoStream");
        t.is(chunks[1]?.outputIndex, 0);
        t.is(chunks[2]?.done, true);
        t.alike(chunks[2]?.stats, {
          generationMs: 900,
          totalVideos: 1,
          totalVideoFrames: 5,
          videoFrames: 5,
          fps: 16,
        });
      },
    );
  },
);

test(
  "video op: broad cancel routes through registry and calls model.cancel",
  async function (t) {
    const [{ getRequestRegistry }, { video: videoOp }] = await Promise.all([
      import("@/server/bare/runtime"),
      import("@/server/bare/plugins/sdcpp-generation/ops/video"),
    ]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelCalls = 0;
    const requestId = makeId("video-req");

    await withRegisteredVideoModel(
      async function () {
        return {
          stats: {
            generationMs: 900,
            totalVideos: 1,
            totalVideoFrames: 5,
            videoFrames: 5,
            fps: 16,
          },
          iterate: async function* () {
            await gate;
            yield new Uint8Array([82, 73, 70, 70]);
          },
        };
      },
      async (modelId) => {
        const gen = videoOp({
          modelId,
          requestId,
          mode: "txt2vid",
          prompt: "a running fox",
          video_frames: 5,
        });
        const firstChunk = gen.next();
        await Promise.resolve();
        await Promise.resolve();

        const ctx = getRequestRegistry().get(requestId);
        t.ok(ctx !== null, "video op registered the request");
        t.is(ctx?.kind, "diffusion");
        t.is(ctx?.modelId, modelId);

        const cancelled = getRequestRegistry().cancel({ modelId });
        t.is(cancelled, 1, "registry cancelled the video generation");
        t.is(cancelCalls, 1, "registry abort forwarded to model.cancel()");

        release();
        const result = await firstChunk;
        t.is(
          result.value?.done,
          true,
          "cancelled stream still emits final marker",
        );

        await gen.next();
        t.is(
          getRequestRegistry().get(requestId),
          null,
          "registry slot was freed",
        );
      },
      async function () {
        cancelCalls++;
      },
    );
  },
);

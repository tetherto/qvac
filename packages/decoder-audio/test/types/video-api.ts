import { VideoFrameDecoder, type VideoFrame, type VideoInput, type VideoInfo } from "../..";

const decoder = new VideoFrameDecoder({ mode: "auto", maxFrames: 8 });
const inputs: VideoInput[] = ["/clip.mp4", new Uint8Array(), {
  size: 1,
  read(_offset: number, length: number) { return new Uint8Array(length); },
}];
const info: Promise<VideoInfo> = decoder.probe(inputs[0]);
const frames: AsyncIterable<VideoFrame> = decoder.frames(inputs[0]);
void info;
void frames;
// @ts-expect-error -- live URLs are not implicitly fetched.
decoder.frames(new URL("https://example.org/video.mp4"));
// @ts-expect-error -- raw text chunks are not video bytes.
decoder.frames((async function* () { yield "text"; })());
// @ts-expect-error -- random access callbacks must be synchronous.
decoder.frames({ size: 1, async read() { return new Uint8Array(1); } });
// @ts-expect-error -- reject invalid modes at the type boundary as well.
new VideoFrameDecoder({ mode: "live" });

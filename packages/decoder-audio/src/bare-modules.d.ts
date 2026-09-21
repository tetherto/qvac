// Ambient declarations for untyped runtime dependencies.
//
// `bare-ffmpeg` ships no type declarations, so the members this package uses are
// declared here by hand against bare-ffmpeg@1.5.0. Only the surface touched by
// src/index.ts is covered — extend it as needed rather than widening to `any`.

declare module "bare-ffmpeg" {
  /** Opaque channel layout handle. Constructed by bare-ffmpeg, never by this package. */
  export class ChannelLayout {
    readonly nbChannels: number;
    readonly mask: number;
  }

  /**
   * A channel layout accepted by bare-ffmpeg setters. `ChannelLayout.from()` normalises
   * a raw mask (e.g. `constants.channelLayouts.MONO`), a preset name, or an existing layout.
   */
  export type ChannelLayoutInput = ChannelLayout | number | string;

  export class Frame {
    format: number;
    sampleRate: number;
    nbSamples: number;
    /**
     * Reading yields a `ChannelLayout`; writing accepts a raw mask or preset name too.
     * The asymmetry mirrors bare-ffmpeg's getter/setter pair.
     */
    get channelLayout(): ChannelLayout;
    set channelLayout(value: ChannelLayoutInput);
    unref(): void;
    destroy(): void;
  }

  export class Samples {
    /**
     * NOTE: takes an options object. Earlier call sites passed
     * `(format, nbChannels, nbSamples)`, which bare-ffmpeg silently discarded.
     */
    constructor(opts?: { noAlignment?: boolean });
    /** Backing buffer, (re)allocated by `fill()`/`read()`. Undefined until then. */
    readonly data: Buffer;
    readonly format: number;
    readonly channelLayout: ChannelLayout;
    readonly nbSamples: number;
    readonly nbChannels: number;
    fill(frame: Frame): number;
    read(frame: Frame): void;
  }

  export class Packet {
    constructor(buffer?: Uint8Array);
    unref(): void;
    destroy(): void;
  }

  export class Resampler {
    constructor(
      inputSampleRate: number,
      inputChannelLayout: ChannelLayoutInput,
      inputFormat: number,
      outputSampleRate: number,
      outputChannelLayout: ChannelLayoutInput,
      outputFormat: number,
    );
    /** Returns the number of samples written to `outputFrame`. */
    convert(inputFrame: Frame, outputFrame: Frame): number;
    /** Drains buffered samples; returns the number written, or 0 when exhausted. */
    flush(outputFrame: Frame): number;
    destroy(): void;
  }

  export interface IOContextOptions {
    /** Returns bytes read, or 0 for EOF. */
    onread?: (buffer: Buffer, requestedLen: number) => number;
    /** Returns the new offset, the stream size for AVSEEK_SIZE, or -1 on error. */
    onseek?: (offset: number, whence: number) => number;
    onwrite?: (buffer: Buffer) => number;
  }

  export class IOContext {
    /** `buffer` may be an internal buffer size or a backing byte array. */
    constructor(buffer: number | Uint8Array, opts?: IOContextOptions);
    destroy(): void;
  }

  export class CodecParameters {
    readonly sampleRate: number;
    readonly format: number;
    readonly channelLayout: ChannelLayout;
    readonly nbChannels: number;
    readonly bitRate: number;
    readonly id: number;
  }

  export class Codec {
    readonly id: number;
    /** Resolved from the numeric codec id; always present for streams parsed from a container. */
    readonly name: string;
  }

  /** Decoding side of a stream. Returned by `Stream.decoder()`. */
  export class CodecContext {
    open(): void;
    sendPacket(packet: Packet): boolean;
    /** Fills `frame` and returns true while frames remain available. */
    receiveFrame(frame: Frame): boolean;
    destroy(): void;
  }

  export class Stream {
    readonly index: number;
    readonly codec: Codec;
    readonly codecParameters: CodecParameters;
    decoder(): CodecContext;
  }

  export class InputFormatContext {
    constructor(io: IOContext);
    readonly streams: Stream[];
    /** Reads the next packet; returns false at end of stream. */
    readFrame(packet: Packet): boolean;
    destroy(): void;
  }

  export const constants: {
    sampleFormats: {
      NONE: number;
      U8: number;
      S16: number;
      S32: number;
      S64: number;
      FLT: number;
      DBL: number;
      U8P: number;
      S16P: number;
      S32P: number;
      S64P: number;
      FLTP: number;
      DBLP: number;
      NB: number;
    };
    channelLayouts: {
      MONO: number;
      STEREO: number;
      QUAD: number;
      SURROUND: number;
    };
  };
}

declare const __dirname: string;
declare function require(id: string): unknown;
declare const module: { exports: unknown };

// Hand-written declarations for ./audio-format.js (kept as JS: it uses the Node
// Buffer API and lazy-loads bare-ffmpeg). Output-format helpers for
// @qvac/audiogen-ggml.

/**
 * Output formats the addon can produce.
 *   - `pcm`  : raw interleaved Int16 samples (no container), dependency-free.
 *   - `wav`  : 16-bit PCM WAV, dependency-free.
 *   - `flac` : lossless FLAC (bare-ffmpeg).
 *   - `alac` : Apple Lossless in an MP4/M4A container (bare-ffmpeg).
 *   - `aiff` : uncompressed 16-bit PCM in an AIFF container (bare-ffmpeg).
 *   - `caf`  : uncompressed 16-bit PCM in a Core Audio Format container (bare-ffmpeg).
 *   - `m4a`  : AAC in an MP4/M4A container (bare-ffmpeg).
 *   - `aac`  : raw AAC / ADTS (bare-ffmpeg).
 *   - `opus` : Opus in an Ogg container, resampled to 48 kHz (bare-ffmpeg).
 *   - `ogg`  : Vorbis in an Ogg container (bare-ffmpeg).
 *   - `ac3`  : Dolby Digital (AC-3) (bare-ffmpeg).
 *   - `wma`  : Windows Media Audio v2 in an ASF container (bare-ffmpeg).
 *   - `mp2`  : MPEG-1 Audio Layer II (bare-ffmpeg).
 *
 * Note: MP3 is intentionally absent — the vendored bare-ffmpeg build ships no
 * MP3 encoder (libmp3lame).
 */
export type OutputFormat =
  | 'pcm'
  | 'wav'
  | 'flac'
  | 'alac'
  | 'aiff'
  | 'caf'
  | 'm4a'
  | 'aac'
  | 'opus'
  | 'ogg'
  | 'ac3'
  | 'wma'
  | 'mp2'

export interface EncodeOptions {
  sampleRate?: number
  channels?: number
}

export interface EncodedAudio {
  /** The format this buffer was encoded to. */
  format: OutputFormat
  /** Encoded bytes (container + payload, or raw PCM for `pcm`). */
  data: Uint8Array
  /** File extension without the dot, e.g. `"wav"`, `"m4a"`. */
  extension: string
  /** MIME type, e.g. `"audio/wav"`, `"audio/mp4"`. */
  mimeType: string
}

/** All output formats supported by {@link encodePcm}. */
export const SUPPORTED_FORMATS: OutputFormat[]

/** MIME type per output format. */
export const MIME_TYPES: Record<OutputFormat, string>

/** FFmpeg encoding recipe per compressed format (container/encoder/etc.). */
export const FFMPEG_FORMATS: Record<
  Exclude<OutputFormat, 'pcm'>,
  {
    container: string
    encoder: string
    sampleFormat: string
    extension: string
    mimeType: string
    rate?: number
    experimental?: boolean
  }
>

/** Wrap interleaved Int16 PCM in a 16-bit PCM WAV container (pure JS). */
export function pcmToWav (pcm: Uint8Array, opts?: EncodeOptions): Uint8Array

/**
 * Encode interleaved Int16 PCM into one or more output formats.
 * One format in -> one file out; an array in -> an array out (input order).
 */
export function encodePcm (
  pcm: Uint8Array,
  format?: OutputFormat,
  opts?: EncodeOptions
): EncodedAudio
export function encodePcm (
  pcm: Uint8Array,
  formats: OutputFormat[],
  opts?: EncodeOptions
): EncodedAudio[]
// Implementation-compatible overload: lets callers delegate a value that is
// itself `OutputFormat | OutputFormat[]` (e.g. AudioGen.encode) without a
// redundant Array.isArray() branch. Direct callers still hit the precise
// single/array overloads above.
export function encodePcm (
  pcm: Uint8Array,
  formats?: OutputFormat | OutputFormat[],
  opts?: EncodeOptions
): EncodedAudio | EncodedAudio[]

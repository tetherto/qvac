/**
 * Audio formats that require decoding before processing
 */
export const FORMATS_NEEDING_DECODE: readonly string[] = [
  ".mp3",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
  ".wav",
];

/**
 * All supported audio formats (including raw)
 */
export const SUPPORTED_AUDIO_FORMATS: readonly string[] = [
  ".mp3",
  ".m4a",
  ".ogg",
  ".wav",
  ".flac",
  ".aac",
  ".raw",
];

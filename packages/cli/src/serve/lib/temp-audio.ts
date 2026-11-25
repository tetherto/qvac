import { extname } from 'node:path'
import { writePrivateTempFile } from '@/serve/lib/temp-file'

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/x-m4a': '.m4a'
}

// The SDK's audio decoder reads files and picks the decoder by extension, so
// an upload is written out under the name or type the client declared. The
// caller removes it with removePrivateTempFile, typically in a finally block.
export function writeTempAudio(
  audio: Buffer,
  fileMeta: { filename: string; mimetype: string } | undefined
): Promise<string> {
  const originalName = fileMeta?.filename ?? ''
  const ext = extname(originalName) || MIME_TO_EXT[fileMeta?.mimetype ?? ''] || '.bin'
  return writePrivateTempFile(`audio${ext}`, audio)
}

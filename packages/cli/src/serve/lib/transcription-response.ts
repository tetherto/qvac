import type { TranscribeSegment } from '@qvac/sdk'

export type TimedTranscriptionFormat = 'srt' | 'vtt' | 'verbose_json'

interface PartialVerboseSegment {
  id: number
  start: number
  end: number
  text: string
}

interface PartialVerboseTranscription {
  text: string
  duration: number
  segments: PartialVerboseSegment[]
}

export type TimedTranscriptionResponse =
  | { contentType: 'text/plain; charset=utf-8'; body: string }
  | { contentType: 'text/vtt; charset=utf-8'; body: string }
  | { contentType: 'application/json; charset=utf-8'; body: PartialVerboseTranscription }

export function isTimedTranscriptionFormat(format: string): format is TimedTranscriptionFormat {
  return format === 'srt' || format === 'vtt' || format === 'verbose_json'
}

export function formatTimedTranscription(
  format: TimedTranscriptionFormat,
  segments: TranscribeSegment[]
): TimedTranscriptionResponse {
  switch (format) {
    case 'srt':
      return { contentType: 'text/plain; charset=utf-8', body: formatCues(segments, ',') }
    case 'vtt':
      return {
        contentType: 'text/vtt; charset=utf-8',
        body: `WEBVTT\n${segments.length > 0 ? `\n${formatCues(segments, '.')}` : ''}`
      }
    case 'verbose_json':
      return {
        contentType: 'application/json; charset=utf-8',
        body: {
          text: segments
            .map((segment) => segment.text)
            .join('')
            .trim(),
          duration:
            segments.reduce(
              (maximumEndMs, segment) => Math.max(maximumEndMs, roundMilliseconds(segment.endMs)),
              0
            ) / 1000,
          segments: segments.map((segment) => ({
            id: segment.id,
            start: roundMilliseconds(segment.startMs) / 1000,
            end: roundMilliseconds(segment.endMs) / 1000,
            text: segment.text
          }))
        }
      }
    default: {
      const exhaustive: never = format
      return exhaustive
    }
  }
}

function formatCues(segments: TranscribeSegment[], separator: ',' | '.'): string {
  // SRT and WebVTT both require cue start times in non-decreasing order.
  return segments
    .map((segment) => ({
      ...segment,
      text: segment.text.trim().replace(/\s*[\r\n]+\s*/g, ' ')
    }))
    .filter((segment) => segment.text.length > 0)
    .sort(
      (a, b) =>
        cueMilliseconds(a.startMs) - cueMilliseconds(b.startMs) ||
        cueMilliseconds(a.endMs) - cueMilliseconds(b.endMs)
    )
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.startMs, separator)} --> ${formatTimestamp(
          segment.endMs,
          separator
        )}\n${segment.text}\n`
    )
    .join('\n')
}

function formatTimestamp(milliseconds: number, separator: ',' | '.'): string {
  const roundedMilliseconds = cueMilliseconds(milliseconds)
  const hours = Math.floor(roundedMilliseconds / 3_600_000)
  const minutes = Math.floor((roundedMilliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((roundedMilliseconds % 60_000) / 1_000)
  const millis = roundedMilliseconds % 1_000
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${separator}${pad(millis, 3)}`
}

function cueMilliseconds(milliseconds: number): number {
  return Math.max(0, roundMilliseconds(milliseconds))
}

function roundMilliseconds(milliseconds: number): number {
  return Math.round(milliseconds)
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

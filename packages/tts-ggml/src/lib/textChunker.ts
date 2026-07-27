/**
 * Text chunking for sentence-stream TTS. Intl.Segmenter is used when present;
 * Bare runtimes without it fall back to punctuation and max-length splitting.
 */

export interface SplitTtsTextOptions {
  language?: string;
  locale?: string;
  maxScalars?: number;
  mergeToMaxScalars?: boolean;
}

export function intlSentenceSegmentationAvailable(): boolean {
  return (
    typeof Intl !== "undefined" &&
    "Segmenter" in Intl &&
    typeof Intl.Segmenter === "function"
  );
}

export function splitByIntlSentences(
  text: string,
  locale?: string,
): string[] | null {
  if (!intlSentenceSegmentationAvailable()) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const segmenter = new Intl.Segmenter(locale || "en", {
      granularity: "sentence",
    });
    const output: string[] = [];
    for (const segment of segmenter.segment(trimmed)) {
      const part = segment.segment.trim();
      if (part.length > 0) output.push(part);
    }
    return output.length === 0 ? null : output;
  } catch {
    return null;
  }
}

const SENTENCE_TERMINATORS = /([.!?。！？؟])(\s*)/gu;

export function splitByAsciiAndCjkPunctuation(text: string): string[] {
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_TERMINATORS.exec(text)) !== null) {
    const end = match.index + match[1].length;
    const slice = text.slice(lastIndex, end).trim();
    if (slice.length > 0) parts.push(slice);
    lastIndex = match.index + match[0].length;
  }
  const tail = text.slice(lastIndex).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function splitByParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

const MIN_CHUNK_GRAPHEMES = 10;

function mergeShortChunks(chunks: string[]): string[] {
  const merged: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    if (buffer.length === 0) {
      buffer = chunk;
      continue;
    }
    if ([...buffer].length < MIN_CHUNK_GRAPHEMES) {
      buffer = buffer + " " + chunk;
    } else {
      merged.push(buffer);
      buffer = chunk;
    }
  }
  if (buffer.length > 0) merged.push(buffer);
  return merged;
}

export function countScalars(value: string): number {
  return [...value].length;
}

const MIN_HARD_SPLIT_SCALARS = 10;

function hardSplitByMaxScalars(text: string, maxScalars: number): string[] {
  const maximum = Math.max(maxScalars, MIN_HARD_SPLIT_SCALARS);
  const graphemes = [...text];
  if (graphemes.length <= maximum) return [text];
  const output: string[] = [];
  for (let index = 0; index < graphemes.length; index += maximum) {
    output.push(graphemes.slice(index, index + maximum).join(""));
  }
  return output;
}

function mergeUpToMaxScalars(
  pieces: string[],
  maxScalars: number,
): string[] {
  const output: string[] = [];
  let current = "";
  for (const rawPiece of pieces) {
    const piece = rawPiece.trim();
    if (!piece) continue;
    const trial = current.length ? `${current} ${piece}` : piece;
    if (countScalars(trial) <= maxScalars) {
      current = trial;
    } else {
      if (current.length > 0) {
        output.push(...hardSplitByMaxScalars(current, maxScalars));
      }
      current = piece;
    }
  }
  if (current.length > 0) {
    output.push(...hardSplitByMaxScalars(current, maxScalars));
  }
  return output.filter((value) => value.trim().length > 0);
}

export const KOREAN_MAX_CHUNK_SCALARS = 120;
export const DEFAULT_MAX_CHUNK_SCALARS = 300;

export function defaultMaxChunkScalars(language?: string): number {
  return (language || "en").toLowerCase() === "ko"
    ? KOREAN_MAX_CHUNK_SCALARS
    : DEFAULT_MAX_CHUNK_SCALARS;
}

export function splitTtsText(
  text: string,
  options: SplitTtsTextOptions = {},
): string[] {
  const mergeToMaxScalars = options.mergeToMaxScalars !== false;
  const language = (options.language || "en").toLowerCase();
  const maxScalars =
    options.maxScalars ?? defaultMaxChunkScalars(language);
  const raw = text.trim();
  if (!raw) return [];

  let sentences = splitByIntlSentences(
    raw,
    options.locale || language,
  );
  if (!sentences || sentences.length === 0) {
    const paragraphs = splitByParagraphs(raw);
    const blocks = paragraphs.length > 0 ? paragraphs : [raw];
    sentences = [];
    for (const paragraph of blocks) {
      const split = splitByAsciiAndCjkPunctuation(paragraph);
      const merged = mergeShortChunks(
        split.length > 0 ? split : [paragraph],
      );
      for (const chunk of merged) {
        if (chunk.trim()) sentences.push(chunk.trim());
      }
    }
  }

  if (sentences.length === 0) {
    return mergeToMaxScalars
      ? mergeUpToMaxScalars([raw], maxScalars)
      : [raw];
  }
  return mergeToMaxScalars
    ? mergeUpToMaxScalars(sentences, maxScalars)
    : sentences;
}

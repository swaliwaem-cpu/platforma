import {
  hashTrainingFactSuggestionText,
  type TrainingFactSuggestionLocator,
  type TrainingFactSuggestionSegment,
} from './training-fact-suggestion.provider';

const DEFAULT_CHUNK_CHARACTERS = 30_000;
const MIN_CHUNK_CHARACTERS = 2_000;
const MAX_CHUNK_CHARACTERS = 36_000;

export type TrainingFactSuggestionSourceInput = {
  id: string;
  checksum: string;
  extractedText: string;
  extractionMetadata: unknown;
};

export type TrainingFactSuggestionChunk = {
  id: string;
  index: number;
  sourceIds: string[];
  segments: TrainingFactSuggestionSegment[];
  inputHash: string;
};

type ExtractionSegment = {
  locator: TrainingFactSuggestionLocator;
  start: number;
  end: number;
};

export function buildTrainingFactSuggestionChunks(
  sources: TrainingFactSuggestionSourceInput[],
  maximumCharacters = DEFAULT_CHUNK_CHARACTERS,
) {
  if (
    !Number.isInteger(maximumCharacters) ||
    maximumCharacters < MIN_CHUNK_CHARACTERS ||
    maximumCharacters > MAX_CHUNK_CHARACTERS
  ) {
    throw new RangeError(
      `Fact suggestion chunk size must be from ${MIN_CHUNK_CHARACTERS} to ${MAX_CHUNK_CHARACTERS}`,
    );
  }

  const sourceSnapshots = sources.map((source) => {
    const extractedText = source.extractedText;
    if (!source.id.trim() || !extractedText.trim()) {
      throw new Error('Fact suggestion source and extracted text are required');
    }
    return {
      id: source.id,
      checksum: source.checksum,
      textHash: hashTrainingFactSuggestionText(extractedText),
      extractedText,
      segments: readExtractionSegments(
        source.id,
        extractedText,
        source.extractionMetadata,
        maximumCharacters,
      ),
    };
  });
  const pieces = sourceSnapshots.flatMap((source) => source.segments);
  const chunks: TrainingFactSuggestionChunk[] = [];
  let current: TrainingFactSuggestionSegment[] = [];
  let currentCharacters = 0;

  const flush = () => {
    if (current.length === 0) return;
    const index = chunks.length;
    chunks.push({
      id: `chunk-${index + 1}`,
      index,
      sourceIds: [...new Set(current.map((segment) => segment.sourceId))],
      segments: current,
      inputHash: hashTrainingFactSuggestionText(
        JSON.stringify(
          current.map((segment) => ({
            id: segment.id,
            sourceId: segment.sourceId,
            locator: segment.locator,
            text: segment.text,
          })),
        ),
      ),
    });
    current = [];
    currentCharacters = 0;
  };

  for (const piece of pieces) {
    if (
      current.length > 0 &&
      currentCharacters + piece.text.length > maximumCharacters
    ) {
      flush();
    }
    current.push(piece);
    currentCharacters += piece.text.length;
  }
  flush();

  return {
    sourceSnapshots: sourceSnapshots.map((source) => ({
      id: source.id,
      checksum: source.checksum,
      textHash: source.textHash,
    })),
    chunks,
    inputHash: hashTrainingFactSuggestionText(
      JSON.stringify(
        sourceSnapshots.map((source) => ({
          id: source.id,
          checksum: source.checksum,
          textHash: source.textHash,
        })),
      ),
    ),
  };
}

function readExtractionSegments(
  sourceId: string,
  extractedText: string,
  metadata: unknown,
  maximumCharacters: number,
) {
  const metadataSegments =
    isRecord(metadata) && Array.isArray(metadata.segments)
      ? metadata.segments
      : [];
  const parsed = metadataSegments
    .map(parseExtractionSegment)
    .filter((value): value is ExtractionSegment => value !== null)
    .filter(
      (segment) =>
        segment.start >= 0 &&
        segment.end > segment.start &&
        segment.end <= extractedText.length,
    );
  const baseSegments =
    parsed.length > 0
      ? parsed
      : [
          {
            locator: {
              section: 'Внесённый текст',
              paragraph: 1,
            },
            start: 0,
            end: extractedText.length,
          },
        ];
  const result: TrainingFactSuggestionSegment[] = [];

  baseSegments.forEach((segment, segmentIndex) => {
    const text = extractedText.slice(segment.start, segment.end).trim();
    if (!text) return;
    const parts = splitBoundedText(text, maximumCharacters);
    parts.forEach((part, partIndex) => {
      result.push({
        id: `${sourceId}:${segmentIndex + 1}:${partIndex + 1}`,
        sourceId,
        locator: segment.locator,
        text: part,
      });
    });
  });

  return result;
}

function parseExtractionSegment(value: unknown): ExtractionSegment | null {
  if (
    !isRecord(value) ||
    !isRecord(value.locator) ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end)
  ) {
    return null;
  }
  return {
    locator: value.locator as TrainingFactSuggestionLocator,
    start: Number(value.start),
    end: Number(value.end),
  };
}

function splitBoundedText(value: string, maximumCharacters: number) {
  const parts: string[] = [];
  let offset = 0;

  while (offset < value.length) {
    const hardEnd = Math.min(value.length, offset + maximumCharacters);
    let end = hardEnd;
    if (hardEnd < value.length) {
      const candidate = Math.max(
        value.lastIndexOf('\n', hardEnd),
        value.lastIndexOf('. ', hardEnd),
        value.lastIndexOf('! ', hardEnd),
        value.lastIndexOf('? ', hardEnd),
      );
      if (candidate > offset + Math.floor(maximumCharacters * 0.6)) {
        end = candidate + 1;
      }
    }
    const part = value.slice(offset, end).trim();
    if (part) parts.push(part);
    offset = end;
  }

  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

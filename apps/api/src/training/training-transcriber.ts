import { Injectable } from '@nestjs/common';

import {
  TRAINING_FACT_ALIAS_MAX_LENGTH,
  TRAINING_FACT_ALIAS_MAX_WORDS,
  type TrainingProjectSnapshotFact,
} from './training-snapshot';
import type { TrainingOpenAIUsage } from './training-openai-usage';

export const TRAINING_TRANSCRIBER = Symbol('TRAINING_TRANSCRIBER');

export type TrainingTranscriptionInput = {
  projectId: string;
  attemptId: string;
  answerId: string;
  fileId: string;
  mimeType: 'audio/wav';
  sizeBytes: number;
  checksum: string;
  wav: Buffer;
  vocabularyPrompt: string;
};

export type TrainingTranscriptionResult = {
  text: string;
  model: string;
  requestId: string | null;
  latencyMs: number;
  attempts: number;
  responseId: string | null;
  usage: TrainingOpenAIUsage | null;
};

export interface TrainingTranscriber {
  transcribe(
    input: TrainingTranscriptionInput,
    options?: { signal?: AbortSignal },
  ): Promise<TrainingTranscriptionResult>;
}

@Injectable()
export class DeterministicFakeTrainingTranscriber implements TrainingTranscriber {
  async transcribe(_input: TrainingTranscriptionInput): Promise<TrainingTranscriptionResult> {
    return {
      text: '[fake:pass]',
      model: 'deterministic-fake-transcriber',
      requestId: null,
      latencyMs: 0,
      attempts: 1,
      responseId: null,
      usage: null,
    };
  }
}

const MAX_VOCABULARY_ITEMS = 40;
const MAX_VOCABULARY_PROMPT_LENGTH = 1_500;

export function buildTrainingVocabularyPrompt(input: {
  projectTitle: string;
  relatedObjectTitle: string | null;
  facts: Pick<TrainingProjectSnapshotFact, 'aliases'>[];
}) {
  const items = [
    input.projectTitle,
    input.relatedObjectTitle,
    ...input.facts.flatMap((fact) => fact.aliases),
  ];
  const seen = new Set<string>();
  const vocabulary: string[] = [];

  for (const value of items) {
    if (typeof value !== 'string') continue;
    const item = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    const canonical = item.toLocaleLowerCase('ru-RU');

    if (
      !item ||
      item.length > TRAINING_FACT_ALIAS_MAX_LENGTH ||
      item.split(' ').length > TRAINING_FACT_ALIAS_MAX_WORDS ||
      /[.!?;:\r\n]/u.test(item) ||
      seen.has(canonical)
    ) {
      continue;
    }

    seen.add(canonical);
    vocabulary.push(item);

    if (vocabulary.length >= MAX_VOCABULARY_ITEMS) break;
  }

  if (!vocabulary.length) return '';

  return `Краткий словарь имён и терминов: ${vocabulary.join(', ')}`.slice(
    0,
    MAX_VOCABULARY_PROMPT_LENGTH,
  );
}

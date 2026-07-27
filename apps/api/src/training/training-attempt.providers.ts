import { randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { TrainingAudioError } from './audio/training-audio.error';

export const TRAINING_ATTEMPT_CLOCK = Symbol('TRAINING_ATTEMPT_CLOCK');
export const TRAINING_QUESTION_SELECTOR = Symbol('TRAINING_QUESTION_SELECTOR');
export const TRAINING_TRANSCRIPTION_PROVIDER = Symbol(
  'TRAINING_TRANSCRIPTION_PROVIDER',
);
export const TRAINING_EVALUATION_PROVIDER = Symbol('TRAINING_EVALUATION_PROVIDER');

export type TrainingAttemptClock = {
  now(): Date;
};

export type TrainingQuestionCandidate = {
  id: string;
};

export type TrainingSelectedQuestionCandidate<T extends TrainingQuestionCandidate> = {
  candidate: T;
  randomIndex: number;
};

export type TrainingQuestionSelector = {
  select<T extends TrainingQuestionCandidate>(
    candidates: readonly T[],
    count: number,
  ): TrainingSelectedQuestionCandidate<T>[];
};

export type TrainingTranscriptionSegmentInput = {
  id: string;
  segmentIndex: number;
  fakeTranscript: string;
  fileId?: string;
  mimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  durationMilliseconds?: number;
};

export type TrainingTranscriptionInput = {
  answerId: string;
  attemptQuestionId?: string;
  segments: TrainingTranscriptionSegmentInput[];
  audio?: {
    fileId: string;
    bucket: string;
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
    durationMilliseconds: number;
    segmentCount: number;
  };
};

export type TrainingTranscriptionResult = {
  transcript: string;
  language: string;
  provider: string;
  model: string;
  requestId: string;
  wordCount: number;
};

export type TrainingTranscriptionProvider = {
  transcribe(input: TrainingTranscriptionInput): Promise<TrainingTranscriptionResult>;
};

export type TrainingEvaluationCriterionInput = {
  id: string;
  code: string;
  title: string;
  maxPoints: number;
};

export type TrainingEvaluationFactInput = {
  id: string;
  code: string;
  statement: string;
};

export type TrainingEvaluationInput = {
  answerId: string;
  questionId: string;
  questionText: string;
  questionMaxScore: number;
  transcript: string;
  criteria: TrainingEvaluationCriterionInput[];
  facts: TrainingEvaluationFactInput[];
};

export type TrainingEvaluationCriterionScore = {
  criterionId: string;
  awardedPoints: number;
  evidence?: string;
};

export type TrainingEvaluationFactFinding = {
  factId?: string;
  verdict: 'CORRECT' | 'PARTIAL' | 'MISSING' | 'INCORRECT' | 'UNSUPPORTED';
  claim?: string;
  evidence?: string;
};

export type TrainingEvaluationResult = {
  actualModelId: string;
  reasoningEffort: string | null;
  aiSuggestedScore: number;
  criterionScores: TrainingEvaluationCriterionScore[];
  factFindings: TrainingEvaluationFactFinding[];
  summary: string;
  requestId: string;
  latencyMs: number;
};

export type TrainingEvaluationProvider = {
  evaluate(input: TrainingEvaluationInput): Promise<TrainingEvaluationResult>;
};

@Injectable()
export class SystemTrainingAttemptClock implements TrainingAttemptClock {
  now() {
    return new Date();
  }
}

@Injectable()
export class CryptoTrainingQuestionSelector implements TrainingQuestionSelector {
  select<T extends TrainingQuestionCandidate>(
    candidates: readonly T[],
    count: number,
  ): TrainingSelectedQuestionCandidate<T>[] {
    if (!Number.isInteger(count) || count < 0 || count > candidates.length) {
      throw new RangeError('Training question selection count is invalid');
    }

    const pool = candidates.map((candidate, randomIndex) => ({
      candidate,
      randomIndex,
    }));

    for (let index = 0; index < count; index += 1) {
      const selectedIndex = randomInt(index, pool.length);
      [pool[index], pool[selectedIndex]] = [pool[selectedIndex]!, pool[index]!];
    }

    return pool.slice(0, count);
  }
}

@Injectable()
export class DeterministicFakeTrainingTranscriptionProvider
  implements TrainingTranscriptionProvider
{
  async transcribe(input: TrainingTranscriptionInput): Promise<TrainingTranscriptionResult> {
    const fixture = input.segments
      .map((segment) => segment.fakeTranscript)
      .join('\n');
    if (fixture.includes('[[fake-transcription:retryable]]')) {
      throw new TrainingAudioError(
        'TRANSCRIPTION_RETRYABLE_FAILURE',
        true,
      );
    }
    if (fixture.includes('[[fake-transcription:permanent]]')) {
      throw new TrainingAudioError(
        'TRANSCRIPTION_PERMANENT_FAILURE',
        false,
      );
    }
    if (fixture.includes('[[fake-transcription:timeout]]')) {
      return new Promise<TrainingTranscriptionResult>(() => undefined);
    }
    const transcript = [...input.segments]
      .sort((left, right) => left.segmentIndex - right.segmentIndex)
      .map((segment) => segment.fakeTranscript.trim())
      .filter(Boolean)
      .join('\n');

    return {
      transcript,
      language: 'ru',
      provider: 'fake',
      model: 'fake-transcription-v1',
      requestId: `fake-transcription:${input.answerId}:1`,
      wordCount: countTranscriptWords(transcript),
    };
  }
}

function countTranscriptWords(value: string) {
  return value.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

@Injectable()
export class DeterministicFakeTrainingEvaluationProvider
  implements TrainingEvaluationProvider
{
  async evaluate(input: TrainingEvaluationInput): Promise<TrainingEvaluationResult> {
    const criterionScores = input.criteria.map((criterion) => ({
      criterionId: criterion.id,
      awardedPoints: readCriterionPoints(
        input.transcript,
        criterion.code,
        criterion.maxPoints,
      ),
      evidence: `fake:${criterion.code}`,
    }));
    const factsByCode = new Map(input.facts.map((fact) => [fact.code, fact]));
    const factFindings: TrainingEvaluationFactFinding[] = [];

    for (const match of input.transcript.matchAll(/\[\[incorrect:([^\]]+)\]\]/gu)) {
      const fact = factsByCode.get(match[1]!.trim());
      if (fact) {
        factFindings.push({
          factId: fact.id,
          verdict: 'INCORRECT',
          evidence: match[0],
        });
      }
    }

    for (const match of input.transcript.matchAll(/\[\[unsupported:([^\]]+)\]\]/gu)) {
      const claim = match[1]!.trim();
      if (claim) {
        factFindings.push({
          verdict: 'UNSUPPORTED',
          claim,
          evidence: match[0],
        });
      }
    }

    return {
      actualModelId: 'fake-evaluation-v1',
      reasoningEffort: null,
      aiSuggestedScore: criterionScores.reduce(
        (total, criterion) => total + criterion.awardedPoints,
        0,
      ),
      criterionScores,
      factFindings,
      summary: 'Deterministic fake evaluation',
      requestId: `fake-evaluation:${input.answerId}:1`,
      latencyMs: 0,
    };
  }
}

function readCriterionPoints(transcript: string, code: string, fallback: number) {
  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = transcript.match(
    new RegExp(`\\[\\[criterion:${escapedCode}=([0-9]+(?:\\.[0-9]+)?)\\]\\]`, 'u'),
  );

  if (!match) {
    return fallback;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

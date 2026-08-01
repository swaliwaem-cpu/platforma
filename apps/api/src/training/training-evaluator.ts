import { Injectable } from '@nestjs/common';

export const TRAINING_EVALUATOR = Symbol('TRAINING_EVALUATOR');
export const TRAINING_FAKE_EVALUATION_VERSION = 'stage1-length-v1';
export const TRAINING_MAIN_MAX_SCORE = 55;
export const TRAINING_FOLLOW_UP_MAX_SCORE = 15;
const TRAINING_TOTAL_MAX_SCORE = 100;

export type TrainingEvaluation = {
  score: number;
  outcome: 'SCORED' | 'REQUIRES_REVIEW';
  safeBreakdown: {
    version: typeof TRAINING_FAKE_EVALUATION_VERSION;
    basis: 'TEXT_LENGTH' | 'FAKE_PASS' | 'FAKE_FAIL' | 'FAKE_REVIEW';
    awardedScore: number;
    maxScore: number;
  };
};

export interface TrainingEvaluator {
  readonly version: string;
  evaluate(text: string, maxScore: number): TrainingEvaluation;
}

@Injectable()
export class DeterministicFakeTrainingEvaluator implements TrainingEvaluator {
  readonly version = TRAINING_FAKE_EVALUATION_VERSION;

  evaluate(text: string, maxScore: number): TrainingEvaluation {
    const boundedMaxScore = clampScore(maxScore, TRAINING_MAIN_MAX_SCORE);
    const normalizedText = text.trim().toLocaleLowerCase('ru-RU');
    let basis: TrainingEvaluation['safeBreakdown']['basis'] = 'TEXT_LENGTH';
    let outcome: TrainingEvaluation['outcome'] = 'SCORED';
    let score = Math.min(boundedMaxScore, normalizedText.length);

    if (normalizedText === '[fake:pass]') {
      basis = 'FAKE_PASS';
      score = boundedMaxScore;
    } else if (normalizedText === '[fake:fail]') {
      basis = 'FAKE_FAIL';
      score = 0;
    } else if (normalizedText === '[fake:review]') {
      basis = 'FAKE_REVIEW';
      outcome = 'REQUIRES_REVIEW';
      score = 0;
    }

    return {
      score: clampScore(score, boundedMaxScore),
      outcome,
      safeBreakdown: {
        version: TRAINING_FAKE_EVALUATION_VERSION,
        basis,
        awardedScore: clampScore(score, boundedMaxScore),
        maxScore: boundedMaxScore,
      },
    };
  }
}

export function clampTrainingTotalScore(score: number) {
  return clampScore(score, TRAINING_TOTAL_MAX_SCORE);
}

function clampScore(score: number, maximum: number) {
  return Math.max(0, Math.min(maximum, Math.trunc(score)));
}

import { Injectable } from '@nestjs/common';

const TRAINING_FOLLOW_UP_COUNT = 3;

export type TrainingRandomSource = () => number;

@Injectable()
export class TrainingFollowUpSelector {
  select<T>(
    candidates: readonly T[],
    randomSource: TrainingRandomSource = Math.random,
  ): T[] {
    if (candidates.length < TRAINING_FOLLOW_UP_COUNT) {
      throw new Error('Not enough follow-up questions');
    }

    const pool = [...candidates];

    for (let index = pool.length - 1; index > 0; index -= 1) {
      const randomValue = randomSource();

      if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
        throw new Error('Random source must return a value in [0, 1)');
      }

      const swapIndex = Math.floor(randomValue * (index + 1));
      const current = pool[index] as T;
      const replacement = pool[swapIndex] as T;

      pool[index] = replacement;
      pool[swapIndex] = current;
    }

    return pool.slice(0, TRAINING_FOLLOW_UP_COUNT);
  }
}

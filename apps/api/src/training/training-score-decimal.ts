import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const TRAINING_SCORE_DECIMAL_PLACES = 2;
export const TRAINING_SCORE_ROUNDING = Prisma.Decimal.ROUND_HALF_UP;

export type TrainingScoreDecimalInput = Prisma.Decimal | number | string;

export function canonicalTrainingScore(
  value: TrainingScoreDecimalInput,
): Prisma.Decimal {
  let decimal: Prisma.Decimal;

  try {
    decimal =
      value instanceof Prisma.Decimal
        ? value
        : new Prisma.Decimal(typeof value === 'number' ? value.toString() : value);
  } catch {
    throw new BadRequestException('Training score must be a finite decimal');
  }

  if (!decimal.isFinite()) {
    throw new BadRequestException('Training score must be a finite decimal');
  }

  return decimal.toDecimalPlaces(
    TRAINING_SCORE_DECIMAL_PLACES,
    TRAINING_SCORE_ROUNDING,
  );
}

export function clampTrainingScore(
  value: TrainingScoreDecimalInput,
  minimum: TrainingScoreDecimalInput,
  maximum: TrainingScoreDecimalInput,
): Prisma.Decimal {
  const roundedValue = canonicalTrainingScore(value);
  const roundedMinimum = canonicalTrainingScore(minimum);
  const roundedMaximum = canonicalTrainingScore(maximum);

  if (roundedMinimum.gt(roundedMaximum)) {
    throw new BadRequestException('Training score range is invalid');
  }
  if (roundedValue.lt(roundedMinimum)) {
    return roundedMinimum;
  }
  if (roundedValue.gt(roundedMaximum)) {
    return roundedMaximum;
  }
  return roundedValue;
}

export function sumTrainingScores(
  values: readonly TrainingScoreDecimalInput[],
): Prisma.Decimal {
  const total = values.reduce<Prisma.Decimal>(
    (sum, value) => sum.plus(canonicalTrainingScore(value)),
    new Prisma.Decimal(0),
  );

  return canonicalTrainingScore(total);
}

export function subtractTrainingScore(
  value: TrainingScoreDecimalInput,
  penalty: TrainingScoreDecimalInput,
): Prisma.Decimal {
  return canonicalTrainingScore(
    canonicalTrainingScore(value).minus(canonicalTrainingScore(penalty)),
  );
}

export function trainingScoreMeetsThreshold(
  value: TrainingScoreDecimalInput,
  threshold: TrainingScoreDecimalInput,
) {
  return canonicalTrainingScore(value).gte(canonicalTrainingScore(threshold));
}

import { BadRequestException } from '@nestjs/common';

const TRAINING_REVIEW_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function parseTrainingReviewIdempotencyKey(value: unknown) {
  if (
    typeof value !== 'string' ||
    !TRAINING_REVIEW_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw new BadRequestException(
      'A valid Idempotency-Key header is required',
    );
  }
  return value;
}

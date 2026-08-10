const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TrainingTelegramOutboxEventType,
} = require('@prisma/client');
const {
  getTrainingTelegramOutboxDeduplicationKey,
} = require('../dist/training/training-telegram-outbox.js');
const {
  getTrainingTelegramOutboxRetryDelayMs,
} = require('../dist/training/training-telegram-outbox-worker.service.js');

test('Telegram outbox deduplication keys are deterministic and event-scoped', () => {
  const answerId = '11111111-1111-4111-8111-111111111111';
  const attemptId = '22222222-2222-4222-8222-222222222222';
  const processed = {
    eventType: TrainingTelegramOutboxEventType.ANSWER_PROCESSED,
    attemptId,
    answerId,
  };

  assert.equal(
    getTrainingTelegramOutboxDeduplicationKey(processed),
    `answer_processed:${answerId}`,
  );
  assert.equal(
    getTrainingTelegramOutboxDeduplicationKey(processed),
    getTrainingTelegramOutboxDeduplicationKey({ ...processed }),
  );
  assert.equal(
    getTrainingTelegramOutboxDeduplicationKey({
      eventType: TrainingTelegramOutboxEventType.ANSWER_FAILED,
      attemptId,
      answerId,
    }),
    `answer_failed:${answerId}`,
  );
  assert.equal(
    getTrainingTelegramOutboxDeduplicationKey({
      eventType: TrainingTelegramOutboxEventType.ATTEMPT_STATE,
      attemptId,
      answerId: null,
    }),
    `attempt_state:${attemptId}`,
  );
});

test('Telegram outbox retry delay grows exponentially and includes bounded jitter', () => {
  const first = getTrainingTelegramOutboxRetryDelayMs(1, 0);
  const second = getTrainingTelegramOutboxRetryDelayMs(2, 0);
  const third = getTrainingTelegramOutboxRetryDelayMs(3, 0);

  assert.equal(second, first * 2);
  assert.equal(third, second * 2);
  assert.equal(getTrainingTelegramOutboxRetryDelayMs(2, Math.floor(second / 4)), second * 1.25 - 1);
  assert.equal(getTrainingTelegramOutboxRetryDelayMs(100, Number.MAX_SAFE_INTEGER), 60 * 60_000);
});

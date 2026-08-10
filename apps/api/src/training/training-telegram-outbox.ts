import {
  TrainingTelegramOutboxEventType,
  type Prisma,
} from '@prisma/client';

export type TrainingTelegramOutboxIntent =
  | {
      eventType: typeof TrainingTelegramOutboxEventType.ANSWER_PROCESSED;
      attemptId: string;
      answerId: string;
    }
  | {
      eventType: typeof TrainingTelegramOutboxEventType.ANSWER_FAILED;
      attemptId: string;
      answerId: string;
    }
  | {
      eventType: typeof TrainingTelegramOutboxEventType.ATTEMPT_STATE;
      attemptId: string;
      answerId?: null;
    };

export async function enqueueTrainingTelegramOutbox(
  transaction: Prisma.TransactionClient,
  intent: TrainingTelegramOutboxIntent,
) {
  await transaction.trainingTelegramOutbox.createMany({
    data: [
      {
        eventType: intent.eventType,
        attemptId: intent.attemptId,
        answerId: intent.answerId ?? null,
        deduplicationKey: getTrainingTelegramOutboxDeduplicationKey(intent),
      },
    ],
    skipDuplicates: true,
  });
}

export function getTrainingTelegramOutboxDeduplicationKey(
  intent: TrainingTelegramOutboxIntent,
) {
  return intent.eventType === TrainingTelegramOutboxEventType.ATTEMPT_STATE
    ? `attempt_state:${intent.attemptId}`
    : `${intent.eventType.toLowerCase()}:${intent.answerId}`;
}

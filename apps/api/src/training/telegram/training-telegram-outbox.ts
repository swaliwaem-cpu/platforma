import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  UserStatus,
} from '@prisma/client';
import { readTrainingCorrelationId } from '../training-safe-log';

export const TRAINING_TELEGRAM_OUTBOX_OPERATION = 'DOMAIN_EVENT';

export type TrainingTelegramOutboxEvent =
  | TrainingTelegramAccountLinkedEvent
  | TrainingTelegramProjectConfirmationEvent
  | TrainingTelegramAttemptQuestionEvent
  | TrainingTelegramAnswerAcceptedEvent
  | TrainingTelegramAttemptResultEvent
  | TrainingTelegramTechnicalFailureEvent;

type TrainingTelegramTarget = {
  eventId: string;
  userId: string;
  accountId: string;
  chatId: string;
  correlationId?: string;
};

export type TrainingTelegramAccountLinkedEvent = TrainingTelegramTarget & {
  operation: typeof TRAINING_TELEGRAM_OUTBOX_OPERATION;
  eventType: 'ACCOUNT_LINKED';
};

export type TrainingTelegramProjectConfirmationEvent =
  TrainingTelegramTarget & {
    operation: typeof TRAINING_TELEGRAM_OUTBOX_OPERATION;
    eventType: 'PROJECT_CONFIRMATION';
    projectId: string;
  };

export type TrainingTelegramAttemptQuestionEvent = TrainingTelegramTarget & {
  operation: typeof TRAINING_TELEGRAM_OUTBOX_OPERATION;
  eventType: 'ATTEMPT_QUESTION';
  attemptId: string;
  attemptQuestionId: string;
};

export type TrainingTelegramAnswerAcceptedEvent = TrainingTelegramTarget & {
  operation: typeof TRAINING_TELEGRAM_OUTBOX_OPERATION;
  eventType: 'ANSWER_ACCEPTED';
  attemptId: string;
  attemptQuestionId: string;
};

export type TrainingTelegramAttemptResultEvent = TrainingTelegramTarget & {
  operation: typeof TRAINING_TELEGRAM_OUTBOX_OPERATION;
  eventType: 'ATTEMPT_RESULT';
  attemptId: string;
};

export type TrainingTelegramTechnicalFailureEvent = TrainingTelegramTarget & {
  operation: typeof TRAINING_TELEGRAM_OUTBOX_OPERATION;
  eventType: 'TECHNICAL_FAILURE';
  attemptId: string;
};

type EnqueueEventInput = {
  event: TrainingTelegramOutboxEvent;
  idempotencyKey: string;
  runAt: Date;
};

export async function enqueueTrainingTelegramOutboxEvent(
  tx: Prisma.TransactionClient,
  input: EnqueueEventInput,
) {
  await tx.trainingJob.createMany({
    data: [
      {
        kind: TrainingJobKind.SEND_TELEGRAM_MESSAGE,
        status: TrainingJobStatus.PENDING,
        payloadJson: input.event as unknown as Prisma.InputJsonObject,
        idempotencyKey: input.idempotencyKey,
        runAt: input.runAt,
        maxAttempts: 5,
      },
    ],
    skipDuplicates: true,
  });
}

export async function enqueueAttemptTelegramOutboxEvent(
  tx: Prisma.TransactionClient,
  input: {
    eventType:
      | 'ATTEMPT_QUESTION'
      | 'ANSWER_ACCEPTED'
      | 'ATTEMPT_RESULT'
      | 'TECHNICAL_FAILURE';
    attemptId: string;
    attemptQuestionId?: string;
    idempotencyKey: string;
    runAt: Date;
    correlationId?: string | null;
  },
) {
  const attempt = await tx.trainingAttempt.findUnique({
    where: { id: input.attemptId },
    select: { userId: true },
  });
  if (!attempt) return;
  const account = await tx.trainingTelegramAccount.findUnique({
    where: { userId: attempt.userId },
    include: {
      user: {
        select: {
          status: true,
          deletedAt: true,
        },
      },
    },
  });
  if (
    !account ||
    account.revokedAt ||
    account.user.status !== UserStatus.ACTIVE ||
    account.user.deletedAt
  ) {
    return;
  }

  const target: TrainingTelegramTarget = {
    eventId: input.idempotencyKey,
    userId: attempt.userId,
    accountId: account.id,
    chatId: account.chatId.toString(),
    ...(readTrainingCorrelationId(input.correlationId)
      ? { correlationId: input.correlationId! }
      : {}),
  };
  let event: TrainingTelegramOutboxEvent;
  if (input.eventType === 'ATTEMPT_RESULT') {
    event = {
      ...target,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: input.eventType,
      attemptId: input.attemptId,
    };
  } else if (input.eventType === 'TECHNICAL_FAILURE') {
    event = {
      ...target,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: input.eventType,
      attemptId: input.attemptId,
    };
  } else {
    if (!input.attemptQuestionId) {
      throw new TypeError(
        `${input.eventType} Telegram outbox event requires attemptQuestionId`,
      );
    }
    event = {
      ...target,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: input.eventType,
      attemptId: input.attemptId,
      attemptQuestionId: input.attemptQuestionId,
    };
  }

  await enqueueTrainingTelegramOutboxEvent(tx, {
    event,
    idempotencyKey: input.idempotencyKey,
    runAt: input.runAt,
  });
}

export function readTrainingTelegramOutboxEvent(
  value: Prisma.JsonObject,
): TrainingTelegramOutboxEvent | null {
  if (value.operation !== TRAINING_TELEGRAM_OUTBOX_OPERATION) return null;
  const base = readTarget(value);
  if (!base) {
    throw new TypeError('Telegram domain outbox target is invalid');
  }

  if (value.eventType === 'ACCOUNT_LINKED') {
    return {
      ...base,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: value.eventType,
    };
  }
  if (
    value.eventType === 'PROJECT_CONFIRMATION' &&
    typeof value.projectId === 'string'
  ) {
    return {
      ...base,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: value.eventType,
      projectId: value.projectId,
    };
  }
  if (
    (value.eventType === 'ATTEMPT_QUESTION' ||
      value.eventType === 'ANSWER_ACCEPTED') &&
    typeof value.attemptId === 'string' &&
    typeof value.attemptQuestionId === 'string'
  ) {
    return {
      ...base,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: value.eventType,
      attemptId: value.attemptId,
      attemptQuestionId: value.attemptQuestionId,
    };
  }
  if (
    (value.eventType === 'ATTEMPT_RESULT' ||
      value.eventType === 'TECHNICAL_FAILURE') &&
    typeof value.attemptId === 'string'
  ) {
    return {
      ...base,
      operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
      eventType: value.eventType,
      attemptId: value.attemptId,
    };
  }
  throw new TypeError('Telegram domain outbox event is invalid');
}

function readTarget(value: Prisma.JsonObject): TrainingTelegramTarget | null {
  if (
    typeof value.eventId === 'string' &&
    typeof value.userId === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.chatId === 'string'
  ) {
    const correlationId = readTrainingCorrelationId(
      value.correlationId,
    );
    return {
      eventId: value.eventId,
      userId: value.userId,
      accountId: value.accountId,
      chatId: value.chatId,
      ...(correlationId ? { correlationId } : {}),
    };
  }
  return null;
}

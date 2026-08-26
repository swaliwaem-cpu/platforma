import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AssistantFeedbackRating,
  AssistantFeedbackReason,
  AssistantRunStatus,
} from '@prisma/client';
import type { AssistantFeedback } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const allowedKeys = new Set(['rating', 'reason', 'comment']);

@Injectable()
export class AssistantFeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async save(messageIdValue: unknown, ownerUserId: string, body: unknown) {
    const messageId = parseUuid(messageIdValue, 'messageId');
    const input = parseFeedbackInput(body);
    const run = await this.prisma.assistantRun.findFirst({
      where: {
        assistantMessageId: messageId,
        ownerUserId,
        status: AssistantRunStatus.COMPLETED,
      },
      select: { id: true },
    });
    if (!run) throw new NotFoundException('ASSISTANT_MESSAGE_NOT_FOUND');

    const feedback = await this.prisma.$transaction(async (transaction) => {
      const saved = await transaction.assistantFeedback.upsert({
        where: { runId: run.id },
        update: input,
        create: {
          runId: run.id,
          ownerUserId,
          ...input,
        },
      });
      await transaction.assistantReviewItem.upsert({
        where: { runId: run.id },
        update: { feedbackId: saved.id },
        create: {
          runId: run.id,
          feedbackId: saved.id,
        },
      });
      return saved;
    });

    return { feedback: serializeAssistantFeedback(feedback) };
  }
}

export function serializeAssistantFeedback(feedback: {
  id: string;
  rating: AssistantFeedbackRating;
  reason: AssistantFeedbackReason | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AssistantFeedback {
  return {
    id: feedback.id,
    rating: feedback.rating,
    reason: feedback.reason,
    comment: feedback.comment,
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
  };
}

function parseFeedbackInput(value: unknown) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new BadRequestException('ASSISTANT_FEEDBACK_INVALID');
  }
  const rating = typeof value.rating === 'string'
    && Object.values(AssistantFeedbackRating).includes(value.rating as AssistantFeedbackRating)
    ? value.rating as AssistantFeedbackRating
    : null;
  const reason = value.reason === undefined || value.reason === null || value.reason === ''
    ? null
    : typeof value.reason === 'string'
      && Object.values(AssistantFeedbackReason).includes(value.reason as AssistantFeedbackReason)
      ? value.reason as AssistantFeedbackReason
      : undefined;
  const comment = value.comment === undefined || value.comment === null || value.comment === ''
    ? null
    : typeof value.comment === 'string'
      ? value.comment.trim().replace(/\s+/gu, ' ')
      : undefined;
  if (!rating || reason === undefined || comment === undefined || (comment !== null && (!comment || comment.length > 500))) {
    throw new BadRequestException('ASSISTANT_FEEDBACK_INVALID');
  }
  return { rating, reason, comment };
}

function parseUuid(value: unknown, field: string) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

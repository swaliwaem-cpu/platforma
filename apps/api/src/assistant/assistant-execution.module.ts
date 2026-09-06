import { Injectable } from '@nestjs/common';
import { AssistantMessageRole, Prisma } from '@prisma/client';
import type {
  AssistantGeoSearchSelection,
  AssistantPageContext,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { AssistantAnswerService } from './assistant-answer.service';
import { parseAssistantGeoStoredValue } from './geo/assistant-geo-contract';
import { AssistantAiUsageBudgetService } from './operations/assistant-ai-usage-budget.service';

@Injectable()
export class AssistantExecutionModule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly answerService: AssistantAnswerService,
    private readonly aiUsageBudgets: AssistantAiUsageBudgetService,
  ) {}

  async execute(runId: string, deadlineAt: Date) {
    const executionId = randomUUID();
    await this.aiUsageBudgets.reconcileExpiredReservations({
      operationRunId: runId,
      executionId,
    });
    const run = await this.prisma.assistantRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        ownerUserId: true,
        conversationId: true,
        userMessage: {
          select: {
            id: true,
            createdAt: true,
            contextJson: true,
            geoContextJson: true,
          },
        },
      },
    });
    const recentMessages = await this.prisma.assistantMessage.findMany({
      where: {
        conversationId: run.conversationId,
        OR: [
          { createdAt: { lt: run.userMessage.createdAt } },
          {
            createdAt: run.userMessage.createdAt,
            id: { lte: run.userMessage.id },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { role: true, content: true },
    });
    const dialog = recentMessages.reverse().map(({ role, content }) => ({
      role: role === AssistantMessageRole.USER ? 'USER' as const : 'ASSISTANT' as const,
      content,
    }));

    return this.answerService.answer({
      messages: dialog.filter(({ role }) => role === 'USER').map(({ content }) => content),
      dialog,
      context: this.parseContext(run.userMessage.contextJson),
      geo: this.parseGeoContext(run.userMessage.geoContextJson),
      actorUserId: run.ownerUserId,
      operationRunId: runId,
      executionId,
      deadlineAt,
    });
  }

  private parseContext(value: Prisma.JsonValue | null): AssistantPageContext | null {
    if (!isRecord(value)) return null;
    if (!['OBJECT', 'LOT', 'DEVELOPER', 'CATALOG_FILTERS'].includes(String(value.kind))) return null;
    if (typeof value.key !== 'string' || typeof value.label !== 'string') return null;
    return {
      kind: value.kind as AssistantPageContext['kind'],
      key: value.key,
      label: value.label,
    };
  }

  private parseGeoContext(value: Prisma.JsonValue | null): AssistantGeoSearchSelection | null {
    return value === null ? null : parseAssistantGeoStoredValue(value, {
      ASSISTANT_GEO_RADIUS_MIN_METERS: '1',
      ASSISTANT_GEO_RADIUS_MAX_METERS: '100000',
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

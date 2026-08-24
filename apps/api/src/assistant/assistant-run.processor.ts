import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  AssistantMessageRole,
  AssistantRunStatus,
  Prisma,
} from '@prisma/client';
import type {
  AssistantProgressEvent,
  AssistantProgressStep,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { isAssistantModuleEnabled } from './assistant-runtime-config';

const assistantRunPollIntervalMs = 1_000;
const assistantRunLeaseMs = 30_000;
const assistantRunClaimBatchSize = 20;

export const assistantProgressDefinitions: readonly {
  step: AssistantProgressStep;
  label: string;
}[] = [
  { step: 'UNDERSTANDING', label: 'Понимаю запрос' },
  { step: 'SEARCHING', label: 'Ищу данные' },
  { step: 'COMPARING', label: 'Сравниваю варианты' },
  { step: 'ANSWERING', label: 'Формирую ответ' },
];

@Injectable()
export class AssistantRunProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantRunProcessor.name);
  private readonly instanceId = randomUUID();
  private readonly activeRunIds = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private isShuttingDown = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.runTick();
    this.pollTimer = setInterval(() => this.scheduleTick(), assistantRunPollIntervalMs);
    this.pollTimer.unref();
  }

  async onModuleDestroy() {
    this.isShuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.tickPromise;
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks]);
    }
  }

  queueRun(runId: string) {
    if (this.isShuttingDown || this.activeRunIds.has(runId)) return;

    this.activeRunIds.add(runId);
    const task = this.executeRun(runId)
      .catch(() => {
        this.logger.error(`Assistant run processing stopped unexpectedly: ${runId}`);
      })
      .finally(() => {
        this.activeRunIds.delete(runId);
        this.activeTasks.delete(task);
      });
    this.activeTasks.add(task);
  }

  private scheduleTick() {
    if (this.isShuttingDown || this.tickPromise) return;
    this.tickPromise = this.runTick().finally(() => {
      this.tickPromise = null;
    });
  }

  private async runTick() {
    if (!isAssistantModuleEnabled()) return;

    try {
      const now = new Date();
      await this.prisma.assistantRun.updateMany({
        where: {
          status: AssistantRunStatus.RUNNING,
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: AssistantRunStatus.PENDING,
          progressJson: [],
          startedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });

      const pendingRuns = await this.prisma.assistantRun.findMany({
        where: { status: AssistantRunStatus.PENDING },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: assistantRunClaimBatchSize,
        select: { id: true },
      });
      pendingRuns.forEach(({ id }) => this.queueRun(id));
    } catch {
      this.logger.error('Assistant run recovery tick failed');
    }
  }

  private async executeRun(runId: string) {
    const startedAt = new Date();
    const claimed = await this.prisma.assistantRun.updateMany({
      where: { id: runId, status: AssistantRunStatus.PENDING },
      data: {
        status: AssistantRunStatus.RUNNING,
        startedAt,
        leaseOwner: this.instanceId,
        leaseExpiresAt: new Date(startedAt.getTime() + assistantRunLeaseMs),
      },
    });
    if (claimed.count !== 1) return;

    try {
      const run = await this.prisma.assistantRun.findUniqueOrThrow({
        where: { id: runId },
        include: { userMessage: true },
      });
      const events: AssistantProgressEvent[] = [];
      const delayMs = this.getFakeStepDelayMs();

      for (const definition of assistantProgressDefinitions) {
        events.push({ ...definition, createdAt: new Date().toISOString() });
        const updated = await this.prisma.assistantRun.updateMany({
          where: {
            id: runId,
            status: AssistantRunStatus.RUNNING,
            leaseOwner: this.instanceId,
          },
          data: { progressJson: events as unknown as Prisma.InputJsonValue },
        });
        if (updated.count !== 1) return;
        if (delayMs > 0) await this.delay(delayMs);
      }

      const content = `Тестовый помощник получил запрос: «${run.userMessage.content}».`;
      await this.prisma.$transaction(async (transaction) => {
        const assistantMessage = await transaction.assistantMessage.create({
          data: {
            conversationId: run.conversationId,
            role: AssistantMessageRole.ASSISTANT,
            content,
          },
        });
        const completed = await transaction.assistantRun.updateMany({
          where: {
            id: runId,
            status: AssistantRunStatus.RUNNING,
            leaseOwner: this.instanceId,
          },
          data: {
            status: AssistantRunStatus.COMPLETED,
            assistantMessageId: assistantMessage.id,
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        if (completed.count !== 1) throw new Error('ASSISTANT_RUN_LEASE_LOST');
        await transaction.assistantConversation.update({
          where: { id: run.conversationId },
          data: { updatedAt: new Date() },
        });
      });
    } catch {
      this.logger.error(`Assistant fake run failed: ${runId}`);
      try {
        await this.prisma.assistantRun.updateMany({
          where: {
            id: runId,
            status: AssistantRunStatus.RUNNING,
            leaseOwner: this.instanceId,
          },
          data: {
            status: AssistantRunStatus.FAILED,
            errorCode: 'ASSISTANT_FAKE_RUN_FAILED',
            completedAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
      } catch {
        this.logger.error(`Assistant failed-run persistence failed: ${runId}`);
        throw new Error('ASSISTANT_RUN_FAILURE_PERSISTENCE_FAILED');
      }
    }
  }

  private getFakeStepDelayMs() {
    const raw = process.env.ASSISTANT_FAKE_STEP_DELAY_MS;
    const value = raw === undefined || raw === '' ? 120 : Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 2_000) return 120;
    return value;
  }

  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}

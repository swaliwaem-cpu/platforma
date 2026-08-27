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
  AssistantPageContext,
  AssistantGeoSearchContext,
  AssistantProgressEvent,
  AssistantProgressStep,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { AssistantAnswerService } from './assistant-answer.service';
import { buildAssistantRunAudit } from './audit/assistant-run-audit';
import { AssistantPlannerError } from './assistant-query-planner';
import { parseAssistantGeoSearchInput } from './geo/assistant-geo-contract';
import { isAssistantModuleEnabled } from './assistant-runtime-config';

const assistantRunPollIntervalMs = 1_000;
const assistantRunLeaseMs = 30_000;
const assistantRunLeaseHeartbeatMs = 10_000;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly answerService: AssistantAnswerService,
  ) {}

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

      const answerResult = await this.withLeaseHeartbeat(runId, async () => {
        const recentMessages = await this.prisma.assistantMessage.findMany({
          where: {
            conversationId: run.conversationId,
            role: AssistantMessageRole.USER,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: { content: true },
        });
        return this.answerService.answer({
          messages: recentMessages.reverse().map(({ content }) => content),
          context: this.parseContext(run.userMessage.contextJson),
          geo: this.parseGeoContext(run.userMessage.geoContextJson),
          operationRunId: runId,
        });
      });
      const latencyMs = Math.max(0, Date.now() - startedAt.getTime());
      const audit = buildAssistantRunAudit({
        intent: answerResult.intent,
        answer: answerResult.answer,
        candidateEvidence: answerResult.candidateEvidence,
        selectedEvidence: answerResult.evidence,
        telemetry: answerResult.telemetry,
        latencyMs,
      });
      await this.prisma.$transaction(async (transaction) => {
        const assistantMessage = await transaction.assistantMessage.create({
          data: {
            conversationId: run.conversationId,
            role: AssistantMessageRole.ASSISTANT,
            content: answerResult.content,
            answerJson: answerResult.answer as unknown as Prisma.InputJsonValue,
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
            intentJson: answerResult.intent as unknown as Prisma.InputJsonValue,
            evidenceJson: answerResult.evidence as unknown as Prisma.InputJsonValue,
            telemetryJson: answerResult.telemetry as unknown as Prisma.InputJsonValue,
            auditJson: audit as unknown as Prisma.InputJsonValue,
            qualityFlags: audit.qualityFlags,
            latencyMs,
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
    } catch (error) {
      this.logger.error(`Assistant grounded run failed: ${runId}`);
      try {
        const telemetry = error instanceof AssistantPlannerError ? error.telemetry : [];
        const latencyMs = Math.max(0, Date.now() - startedAt.getTime());
        const qualityFlags = [
          ...(telemetry.some(({ isFallback }) => isFallback) ? ['MODEL_FALLBACK'] : []),
          ...(telemetry.some(({ outcome }) => outcome === 'PROVIDER_ERROR') ? ['PROVIDER_ERROR'] : []),
          ...(latencyMs > 15_000 ? ['LATENCY_BREACH'] : []),
        ];
        await this.prisma.assistantRun.updateMany({
          where: {
            id: runId,
            status: AssistantRunStatus.RUNNING,
            leaseOwner: this.instanceId,
          },
          data: {
            status: AssistantRunStatus.FAILED,
            errorCode: 'ASSISTANT_GROUNDED_RUN_FAILED',
            telemetryJson: telemetry as unknown as Prisma.InputJsonValue,
            auditJson: {
              schemaVersion: 1,
              appliedFilters: null,
              softPreferences: null,
              candidateSet: [],
              rankingDecisions: [],
              evidenceRevisions: [],
              qualityFlags,
            },
            qualityFlags,
            latencyMs,
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

  private async renewLease(runId: string) {
    const renewedAt = new Date();
    const renewed = await this.prisma.assistantRun.updateMany({
      where: {
        id: runId,
        status: AssistantRunStatus.RUNNING,
        leaseOwner: this.instanceId,
      },
      data: {
        leaseExpiresAt: new Date(renewedAt.getTime() + assistantRunLeaseMs),
      },
    });
    return renewed.count === 1;
  }

  private async withLeaseHeartbeat<Value>(runId: string, action: () => Promise<Value>) {
    let leaseIsCurrent = await this.renewLease(runId);
    if (!leaseIsCurrent) throw new Error('ASSISTANT_RUN_LEASE_LOST');
    let renewal = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal.then(async () => {
        if (leaseIsCurrent) leaseIsCurrent = await this.renewLease(runId);
      }).catch(() => {
        leaseIsCurrent = false;
      });
    }, assistantRunLeaseHeartbeatMs);
    heartbeat.unref();

    try {
      const value = await action();
      await renewal;
      leaseIsCurrent = leaseIsCurrent && await this.renewLease(runId);
      if (!leaseIsCurrent) throw new Error('ASSISTANT_RUN_LEASE_LOST');
      return value;
    } finally {
      clearInterval(heartbeat);
      await renewal;
    }
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

  private parseGeoContext(value: Prisma.JsonValue | null): AssistantGeoSearchContext | null {
    try {
      return value === null ? null : parseAssistantGeoSearchInput(value, {
        ASSISTANT_GEO_RADIUS_MIN_METERS: '1',
        ASSISTANT_GEO_RADIUS_MAX_METERS: '100000',
      });
    } catch {
      return null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

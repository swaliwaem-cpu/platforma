import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const assistantAuditRetentionDays = 30;
const assistantAggregateRetentionDays = 180;
const cleanupBatchSize = 500;
const cleanupIntervalMs = 6 * 60 * 60 * 1_000;

@Injectable()
export class AssistantRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantRetentionService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    void this.runCleanup().catch(() => this.logger.error('Assistant retention cleanup failed'));
    this.timer = setInterval(() => {
      void this.runCleanup().catch(() => this.logger.error('Assistant retention cleanup failed'));
    }, cleanupIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runCleanup(now = new Date()) {
    const auditCutoff = new Date(now.getTime() - assistantAuditRetentionDays * 24 * 60 * 60 * 1_000);
    const aggregateCutoff = new Date(now.getTime() - assistantAggregateRetentionDays * 24 * 60 * 60 * 1_000);
    return this.prisma.$transaction(async (transaction) => {
      const conversations = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"::text AS "id"
        FROM "assistant_conversations"
        WHERE "updated_at" < ${auditCutoff}
        ORDER BY "updated_at" ASC, "id" ASC
        LIMIT ${cleanupBatchSize}
        FOR UPDATE SKIP LOCKED
      `);
      const conversationIds = conversations.map(({ id }) => id);
      const runs = conversationIds.length > 0
        ? await transaction.assistantRun.findMany({
            where: { conversationId: { in: conversationIds } },
            select: { id: true },
          })
        : [];
      const runIds = runs.map(({ id }) => id);
      if (runIds.length > 0) {
        await transaction.assistantReviewItem.deleteMany({ where: { runId: { in: runIds } } });
        await transaction.assistantFeedback.deleteMany({ where: { runId: { in: runIds } } });
        await transaction.assistantRun.deleteMany({ where: { id: { in: runIds } } });
      }
      if (conversationIds.length > 0) {
        await transaction.assistantMessage.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await transaction.assistantConversation.deleteMany({ where: { id: { in: conversationIds } } });
      }
      const geo = await transaction.assistantGeoOperation.deleteMany({
        where: { createdAt: { lt: auditCutoff } },
      });
      const metrics = await transaction.assistantUsageMetric.deleteMany({
        where: { windowStartedAt: { lt: aggregateCutoff } },
      });
      return {
        conversations: conversationIds.length,
        runs: runIds.length,
        geoOperations: geo.count,
        aggregateMetrics: metrics.count,
        sourceRevisions: 0,
      };
    });
  }
}

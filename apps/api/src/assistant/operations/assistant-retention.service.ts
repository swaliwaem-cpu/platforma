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
    const totals = {
      conversations: 0,
      runs: 0,
      geoOperations: 0,
      aggregateMetrics: 0,
      sourceRevisions: 0,
    };

    for (;;) {
      const batch = await this.prisma.$transaction(async (transaction) => {
        const runs = await transaction.$queryRaw<Array<{
          id: string;
          conversationId: string;
          userMessageId: string;
          assistantMessageId: string | null;
        }>>(Prisma.sql`
          SELECT
            "id"::text AS "id",
            "conversation_id"::text AS "conversationId",
            "user_message_id"::text AS "userMessageId",
            "assistant_message_id"::text AS "assistantMessageId"
          FROM "assistant_runs"
          WHERE "created_at" < ${auditCutoff}
            AND "status" IN (
              'completed'::"assistant_run_status",
              'failed'::"assistant_run_status"
            )
          ORDER BY "created_at" ASC, "id" ASC
          LIMIT ${cleanupBatchSize}
          FOR UPDATE SKIP LOCKED
        `);
        const runIds = runs.map(({ id }) => id);
        const linkedMessageIds = [...new Set(runs.flatMap(({ userMessageId, assistantMessageId }) =>
          assistantMessageId ? [userMessageId, assistantMessageId] : [userMessageId]))];

        const orphanMessages = await transaction.$queryRaw<Array<{ id: string; conversationId: string }>>(Prisma.sql`
          SELECT
            "message"."id"::text AS "id",
            "message"."conversation_id"::text AS "conversationId"
          FROM "assistant_messages" AS "message"
          WHERE "message"."created_at" < ${auditCutoff}
            AND NOT EXISTS (
              SELECT 1 FROM "assistant_runs" AS "run"
              WHERE "run"."user_message_id" = "message"."id"
                 OR "run"."assistant_message_id" = "message"."id"
            )
          ORDER BY "message"."created_at" ASC, "message"."id" ASC
          LIMIT ${cleanupBatchSize}
          FOR UPDATE OF "message" SKIP LOCKED
        `);
        const affectedConversationIds = [...new Set([
          ...runs.map(({ conversationId }) => conversationId),
          ...orphanMessages.map(({ conversationId }) => conversationId),
        ])];
        const lockedConversations = affectedConversationIds.length === 0
          ? []
          : await transaction.$queryRaw<Array<{ id: string; updatedAt: Date }>>(Prisma.sql`
              SELECT
                "id"::text AS "id",
                "updated_at" AS "updatedAt"
              FROM "assistant_conversations"
              WHERE "id" IN (${Prisma.join(
                affectedConversationIds.map((id) => Prisma.sql`${id}::uuid`),
              )})
              ORDER BY "id" ASC
              FOR UPDATE
            `);
        const activityByConversationId = new Map(lockedConversations.map(({ id, updatedAt }) => [id, updatedAt]));

        if (runIds.length > 0) {
          await transaction.assistantReviewItem.deleteMany({ where: { runId: { in: runIds } } });
          await transaction.assistantFeedback.deleteMany({ where: { runId: { in: runIds } } });
          await transaction.assistantRun.deleteMany({ where: { id: { in: runIds } } });
          await transaction.assistantMessage.deleteMany({ where: { id: { in: linkedMessageIds } } });
        }
        if (orphanMessages.length > 0) {
          await transaction.assistantMessage.deleteMany({
            where: { id: { in: orphanMessages.map(({ id }) => id) } },
          });
        }

        if (affectedConversationIds.length > 0) {
          const remainingTitles = await transaction.$queryRaw<Array<{ id: string; content: string | null }>>(
            Prisma.sql`
              SELECT
                "conversation"."id"::text AS "id",
                (
                  SELECT "message"."content"
                  FROM "assistant_messages" AS "message"
                  WHERE "message"."conversation_id" = "conversation"."id"
                    AND "message"."role" = 'user'::"assistant_message_role"
                  ORDER BY "message"."created_at" ASC, "message"."id" ASC
                  LIMIT 1
                ) AS "content"
              FROM "assistant_conversations" AS "conversation"
              WHERE "conversation"."id" IN (${Prisma.join(
                affectedConversationIds.map((id) => Prisma.sql`${id}::uuid`),
              )})
            `,
          );
          for (const { id, content } of remainingTitles) {
            const updatedAt = activityByConversationId.get(id);
            if (!updatedAt) continue;
            await transaction.assistantConversation.update({
              where: { id },
              data: {
                title: content ? buildConversationTitle(content) : 'Новый разговор',
                updatedAt,
              },
            });
          }
        }

        const emptyConversations = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "conversation"."id"::text AS "id"
          FROM "assistant_conversations" AS "conversation"
          WHERE "conversation"."updated_at" < ${auditCutoff}
            AND NOT EXISTS (
              SELECT 1 FROM "assistant_messages" AS "message"
              WHERE "message"."conversation_id" = "conversation"."id"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "assistant_runs" AS "run"
              WHERE "run"."conversation_id" = "conversation"."id"
            )
          ORDER BY "conversation"."updated_at" ASC, "conversation"."id" ASC
          LIMIT ${cleanupBatchSize}
          FOR UPDATE OF "conversation" SKIP LOCKED
        `);
        const emptyConversationIds = emptyConversations.map(({ id }) => id);
        if (emptyConversationIds.length > 0) {
          await transaction.assistantConversation.deleteMany({ where: { id: { in: emptyConversationIds } } });
        }

        const geoOperations = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"::text AS "id"
          FROM "assistant_geo_operations"
          WHERE "created_at" < ${auditCutoff}
          ORDER BY "created_at" ASC, "id" ASC
          LIMIT ${cleanupBatchSize}
          FOR UPDATE SKIP LOCKED
        `);
        if (geoOperations.length > 0) {
          await transaction.assistantGeoOperation.deleteMany({
            where: { id: { in: geoOperations.map(({ id }) => id) } },
          });
        }

        const metrics = await transaction.$queryRaw<Array<{
          provider: string;
          model: string;
          window: 'MINUTE' | 'DAY';
          windowStartedAt: Date;
        }>>(Prisma.sql`
          SELECT
            "provider",
            "model",
            UPPER("window"::text) AS "window",
            "window_started_at" AS "windowStartedAt"
          FROM "assistant_usage_metrics"
          WHERE "window_started_at" < ${aggregateCutoff}
          ORDER BY "window_started_at" ASC, "provider" ASC, "model" ASC NULLS FIRST
          LIMIT ${cleanupBatchSize}
          FOR UPDATE SKIP LOCKED
        `);
        for (const metric of metrics) {
          await transaction.assistantUsageMetric.delete({
            where: {
              provider_model_window_windowStartedAt: metric,
            },
          });
        }

        return {
          conversations: emptyConversationIds.length,
          runs: runIds.length,
          geoOperations: geoOperations.length,
          aggregateMetrics: metrics.length,
          processed: runIds.length + orphanMessages.length + emptyConversationIds.length
            + geoOperations.length + metrics.length,
        };
      });
      totals.conversations += batch.conversations;
      totals.runs += batch.runs;
      totals.geoOperations += batch.geoOperations;
      totals.aggregateMetrics += batch.aggregateMetrics;
      if (batch.processed === 0) return totals;
    }
  }
}

function buildConversationTitle(content: string) {
  return content.length <= 160 ? content : `${content.slice(0, 159).trimEnd()}…`;
}

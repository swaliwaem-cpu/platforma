import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  AssistantAdminTurn,
  AssistantAdminTurnResponse,
  AssistantAdminTurnsResponse,
  AssistantAdminTurnSummary,
  AssistantAnswer,
  AssistantLot,
  AssistantSource,
  AssistantTraceStep,
  AssistantTurnFeedbackInput,
  AssistantUsageDay,
  AssistantUsageResponse,
  AssistantUsageTotals,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { AssistantTurnRating, AssistantTurnStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { estimateTrainingAiCost } from '../training/training-ai-pricing';
import type { AssistantAgentTelemetry } from './assistant-agent';

// The assistant's turn log: every question with its answer, tool trace and cost, masked and kept
// for 90 days. Owners rate their own turns; admins read the log and the daily usage.

const retentionDays = 90;
const purgeIntervalMs = 24 * 60 * 60_000;
const firstPurgeDelayMs = 60_000;
const pageSize = 50;
const maxCommentChars = 1_000;
const maxSummaryQuestionChars = 300;

export type AssistantTurnEntry = {
  id: string;
  userId: string;
  conversationId: string | null;
  question: string;
  answer: AssistantAnswer | null;
  telemetry: AssistantAgentTelemetry;
  model: string;
  durationMs: number;
  errorCode: string | null;
  occurredAt: Date;
};

export type AssistantTurnListQuery = {
  rating?: unknown;
  from?: unknown;
  to?: unknown;
  userId?: unknown;
  cursor?: unknown;
};

@Injectable()
export class AssistantTurnLogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AssistantTurnLogService.name);
  private purgeTimers: NodeJS.Timeout[] = [];

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const run = () => {
      void this.purgeExpired().catch((error: unknown) => {
        this.logger.warn(`assistant turn purge failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
      });
    };
    this.purgeTimers = [setTimeout(run, firstPurgeDelayMs), setInterval(run, purgeIntervalMs)];
    this.purgeTimers.forEach((timer) => timer.unref());
  }

  onModuleDestroy() {
    this.purgeTimers.forEach((timer) => clearTimeout(timer));
    this.purgeTimers = [];
  }

  /** Writes a finished turn (answered or failed). The caller decides what a failed write means. */
  async record(entry: AssistantTurnEntry) {
    const { telemetry } = entry;
    const cost = estimateTrainingAiCost(entry.model, {
      inputTokens: telemetry.inputTokens,
      cachedTokens: telemetry.cachedTokens,
      cacheWriteTokens: 0,
      outputTokens: telemetry.outputTokens,
      reasoningTokens: 0,
      totalTokens: telemetry.inputTokens + telemetry.outputTokens,
    }, entry.occurredAt);
    await this.prisma.assistantTurn.create({
      data: {
        id: entry.id,
        userId: entry.userId,
        conversationId: entry.conversationId,
        createdAt: entry.occurredAt,
        question: maskPersonalData(entry.question),
        answerText: entry.answer ? maskPersonalData(entry.answer.text) : null,
        lotsJson: toJson(entry.answer?.lots ?? []),
        sourcesJson: toJson(entry.answer?.sources ?? []),
        traceJson: toJson(telemetry.trace.map((step) => ({ ...step, args: maskValue(step.args) }))),
        model: entry.model,
        modelCalls: telemetry.modelCalls,
        inputTokens: telemetry.inputTokens,
        cachedTokens: telemetry.cachedTokens,
        outputTokens: telemetry.outputTokens,
        estimatedCostUsd: cost.estimatedCostUsd,
        pricingVersion: cost.pricingVersion,
        durationMs: entry.durationMs,
        status: entry.answer ? AssistantTurnStatus.COMPLETED : AssistantTurnStatus.FAILED,
        errorCode: entry.errorCode?.slice(0, 120) ?? null,
      },
    });
  }

  async rate(actor: Pick<AuthenticatedUser, 'id'>, turnId: string, input: AssistantTurnFeedbackInput | undefined) {
    const rating = input?.rating === 'UP' ? AssistantTurnRating.UP : input?.rating === 'DOWN' ? AssistantTurnRating.DOWN : null;
    if (!rating) throw new BadRequestException('ASSISTANT_RATING_INVALID');
    if (input?.comment !== undefined && input.comment !== null && typeof input.comment !== 'string') {
      throw new BadRequestException('ASSISTANT_RATING_COMMENT_INVALID');
    }
    const comment = input?.comment?.trim().slice(0, maxCommentChars) || null;
    // Only the owner's own turn: someone else's turn id looks exactly like a missing one.
    const { count } = await this.prisma.assistantTurn.updateMany({
      where: { id: turnId, userId: actor.id },
      data: { rating, ratingComment: comment ? maskPersonalData(comment) : null, ratedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('ASSISTANT_TURN_NOT_FOUND');
  }

  async listTurns(query: AssistantTurnListQuery): Promise<AssistantAdminTurnsResponse> {
    const where: Prisma.AssistantTurnWhereInput = {};
    const rating = readOptionalString(query.rating);
    if (rating) {
      if (rating !== 'UP' && rating !== 'DOWN') throw new BadRequestException('ASSISTANT_RATING_INVALID');
      where.rating = rating === 'UP' ? AssistantTurnRating.UP : AssistantTurnRating.DOWN;
    }
    const from = readOptionalDate(query.from, 'from');
    const to = readOptionalDate(query.to, 'to');
    if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
    const userId = readOptionalString(query.userId);
    if (userId) {
      if (!uuidPattern.test(userId)) throw new BadRequestException('ASSISTANT_USER_ID_INVALID');
      where.userId = userId;
    }
    const cursor = readCursor(query.cursor);
    const rows = await this.prisma.assistantTurn.findMany({
      where: cursor
        ? { AND: [where, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] }
        : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      select: summarySelect,
    });
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      items: page.map(toSummary),
      nextCursor: rows.length > pageSize && last ? writeCursor(last.createdAt, last.id) : null,
    };
  }

  async getTurn(id: string): Promise<AssistantAdminTurnResponse> {
    const row = await this.prisma.assistantTurn.findUnique({
      where: { id },
      select: {
        ...summarySelect,
        conversationId: true,
        answerText: true,
        sourcesJson: true,
        traceJson: true,
        modelCalls: true,
        inputTokens: true,
        cachedTokens: true,
        outputTokens: true,
        pricingVersion: true,
        ratedAt: true,
      },
    });
    if (!row) throw new NotFoundException('ASSISTANT_TURN_NOT_FOUND');
    const turn: AssistantAdminTurn = {
      ...toSummary(row),
      conversationId: row.conversationId,
      answerText: row.answerText,
      lots: readArray<AssistantLot>(row.lotsJson),
      sources: readArray<AssistantSource>(row.sourcesJson),
      trace: readArray<AssistantTraceStep>(row.traceJson),
      modelCalls: row.modelCalls,
      inputTokens: row.inputTokens,
      cachedTokens: row.cachedTokens,
      outputTokens: row.outputTokens,
      pricingVersion: row.pricingVersion,
      ratedAt: row.ratedAt?.toISOString() ?? null,
    };
    return { turn };
  }

  async usage(daysInput: unknown, now = new Date()): Promise<AssistantUsageResponse> {
    const days = readDays(daysInput);
    const dates = lastMoscowDates(now, days);
    const since = moscowMidnightUtc(dates[0]!);
    const rows = await this.prisma.$queryRaw<Array<{
      day: string;
      turns: bigint;
      failed: bigint;
      ratedUp: bigint;
      ratedDown: bigint;
      users: bigint;
      inputTokens: bigint | null;
      cachedTokens: bigint | null;
      outputTokens: bigint | null;
      costUsd: Prisma.Decimal | null;
    }>>(Prisma.sql`
      SELECT
        to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day,
        COUNT(*)::bigint AS turns,
        COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
        COUNT(*) FILTER (WHERE rating = 'up')::bigint AS "ratedUp",
        COUNT(*) FILTER (WHERE rating = 'down')::bigint AS "ratedDown",
        COUNT(DISTINCT user_id)::bigint AS users,
        SUM(input_tokens)::bigint AS "inputTokens",
        SUM(cached_tokens)::bigint AS "cachedTokens",
        SUM(output_tokens)::bigint AS "outputTokens",
        SUM(estimated_cost_usd) AS "costUsd"
      FROM assistant_turns
      WHERE created_at >= ${since}
      GROUP BY 1
    `);
    const byDay = new Map(rows.map((row) => [row.day, row]));
    const usageDays = dates.map((date): AssistantUsageDay => {
      const row = byDay.get(date);
      return {
        date,
        turns: Number(row?.turns ?? 0),
        failed: Number(row?.failed ?? 0),
        ratedUp: Number(row?.ratedUp ?? 0),
        ratedDown: Number(row?.ratedDown ?? 0),
        users: Number(row?.users ?? 0),
        inputTokens: Number(row?.inputTokens ?? 0),
        cachedTokens: Number(row?.cachedTokens ?? 0),
        outputTokens: Number(row?.outputTokens ?? 0),
        costUsd: Number(row?.costUsd ?? 0),
      };
    });
    const [users] = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT user_id)::bigint AS count FROM assistant_turns WHERE created_at >= ${since}
    `);
    const totals = usageDays.reduce<AssistantUsageTotals>((sum, day) => ({
      turns: sum.turns + day.turns,
      failed: sum.failed + day.failed,
      ratedUp: sum.ratedUp + day.ratedUp,
      ratedDown: sum.ratedDown + day.ratedDown,
      users: sum.users,
      inputTokens: sum.inputTokens + day.inputTokens,
      cachedTokens: sum.cachedTokens + day.cachedTokens,
      outputTokens: sum.outputTokens + day.outputTokens,
      costUsd: sum.costUsd + day.costUsd,
    }), { turns: 0, failed: 0, ratedUp: 0, ratedDown: 0, users: Number(users?.count ?? 0), inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 });
    return { days: usageDays, totals };
  }

  async purgeExpired(now = new Date()) {
    const { count } = await this.prisma.assistantTurn.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - retentionDays * 24 * 60 * 60_000) } },
    });
    if (count > 0) this.logger.log(`assistant turn log: deleted ${count} turns older than ${retentionDays} days`);
    return count;
  }
}

// Russian phone numbers (+7 or 8, any grouping) and e-mail addresses never reach the log.
const phonePattern = /(?<![\d+])(?:\+\s?7|8)[\s\-.]*\(?\d{3}\)?[\s\-.]*\d{3}[\s\-.]*\d{2}[\s\-.]*\d{2}(?!\d)/gu;
const emailPattern = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;

export function maskPersonalData(text: string) {
  return text.replace(emailPattern, '[почта]').replace(phonePattern, '[телефон]');
}

export function maskValue(value: unknown): Record<string, unknown> {
  const mask = (item: unknown): unknown => {
    if (typeof item === 'string') return maskPersonalData(item);
    if (Array.isArray(item)) return item.map(mask);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, mask(nested)]));
    }
    return item;
  };
  const masked = mask(value);
  return masked && typeof masked === 'object' && !Array.isArray(masked) ? masked as Record<string, unknown> : {};
}

const summarySelect = {
  id: true,
  createdAt: true,
  question: true,
  status: true,
  errorCode: true,
  rating: true,
  ratingComment: true,
  lotsJson: true,
  model: true,
  durationMs: true,
  estimatedCostUsd: true,
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AssistantTurnSelect;

type SummaryRow = Prisma.AssistantTurnGetPayload<{ select: typeof summarySelect }>;

function toSummary(row: SummaryRow): AssistantAdminTurnSummary {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    user: row.user,
    question: row.question.length > maxSummaryQuestionChars ? `${row.question.slice(0, maxSummaryQuestionChars)}…` : row.question,
    status: row.status,
    errorCode: row.errorCode,
    rating: row.rating,
    ratingComment: row.ratingComment,
    lotsCount: Array.isArray(row.lotsJson) ? row.lotsJson.length : 0,
    model: row.model,
    durationMs: row.durationMs,
    estimatedCostUsd: row.estimatedCostUsd?.toString() ?? null,
  };
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readArray<T>(value: Prisma.JsonValue): T[] {
  return Array.isArray(value) ? value as unknown as T[] : [];
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalDate(value: unknown, name: string) {
  const text = readOptionalString(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`ASSISTANT_${name.toUpperCase()}_INVALID`);
  return date;
}

function readDays(value: unknown) {
  const days = value === undefined || value === '' ? 30 : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > retentionDays) throw new BadRequestException('ASSISTANT_USAGE_DAYS_INVALID');
  return days;
}

function writeCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function readCursor(value: unknown) {
  const text = readOptionalString(value);
  if (!text) return null;
  const [iso, id] = Buffer.from(text, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (!id || !uuidPattern.test(id) || Number.isNaN(createdAt.getTime())) throw new BadRequestException('ASSISTANT_CURSOR_INVALID');
  return { createdAt, id };
}

// Moscow has no daylight saving time since 2014: always UTC+3.
const moscowOffsetMs = 3 * 60 * 60_000;

function lastMoscowDates(now: Date, days: number) {
  const today = new Date(now.getTime() + moscowOffsetMs);
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1 - index)));
    return day.toISOString().slice(0, 10);
  });
}

function moscowMidnightUtc(date: string) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - moscowOffsetMs);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

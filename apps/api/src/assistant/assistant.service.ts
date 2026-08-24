import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssistantMessageRole as PrismaAssistantMessageRole,
  AssistantRunStatus as PrismaAssistantRunStatus,
  Prisma,
} from '@prisma/client';
import type {
  AssistantAnswer,
  AssistantConversation,
  AssistantConversationSummary,
  AssistantMessage,
  AssistantPageContext,
  AssistantProgressEvent,
  AssistantProgressStep,
  AssistantRun,
  AssistantSearchResultCard,
  AssistantSendMessageInput,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import {
  AssistantRunProcessor,
  assistantProgressDefinitions,
} from './assistant-run.processor';

const assistantHistoryDays = 30;
const assistantHistoryPageSize = 50;
const assistantConversationMessageLimit = 200;
const assistantMessageMaxLength = 4_000;
const assistantContextKeyMaxLength = 512;
const assistantContextLabelMaxLength = 160;
const assistantConversationTitleMaxLength = 80;
const assistantHistoryCursorMaxLength = 512;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const contextKinds = new Set(['OBJECT', 'LOT', 'DEVELOPER', 'CATALOG_FILTERS']);
const answerKinds = new Set(['SEARCH_RESULTS', 'CLARIFICATION', 'REFUSAL', 'SAFE_BOUNDARY']);
const deviationTypes = new Set(['BUDGET', 'DISTRICT', 'DEVELOPER', 'ROOMS']);

const messageSelect = {
  id: true,
  role: true,
  content: true,
  contextJson: true,
  answerJson: true,
  createdAt: true,
} satisfies Prisma.AssistantMessageSelect;

const conversationDetailInclude = {
  messages: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: assistantConversationMessageLimit,
    select: messageSelect,
  },
  _count: { select: { messages: true } },
} satisfies Prisma.AssistantConversationInclude;

const conversationSummarySelect = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { messages: true } },
} satisfies Prisma.AssistantConversationSelect;

const runInclude = {
  assistantMessage: { select: messageSelect },
} satisfies Prisma.AssistantRunInclude;

type StoredConversation = Prisma.AssistantConversationGetPayload<{
  include: typeof conversationDetailInclude;
}>;
type StoredConversationSummary = Prisma.AssistantConversationGetPayload<{
  select: typeof conversationSummarySelect;
}>;
type StoredRun = Prisma.AssistantRunGetPayload<{ include: typeof runInclude }>;
type StoredMessage = Prisma.AssistantMessageGetPayload<{ select: typeof messageSelect }>;
type AssistantHistoryCursor = { id: string; updatedAt: Date };

@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runProcessor: AssistantRunProcessor,
  ) {}

  async createConversation(ownerUserId: string, idempotencyKeyValue: unknown) {
    const creationKey = this.parseUuid(idempotencyKeyValue, 'Idempotency-Key');
    const existing = await this.findConversationByCreationKey(ownerUserId, creationKey);
    if (existing) return { conversation: this.serializeConversation(existing) };

    try {
      const conversation = await this.prisma.assistantConversation.create({
        data: { ownerUserId, creationKey },
        include: conversationDetailInclude,
      });
      return { conversation: this.serializeConversation(conversation) };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.findConversationByCreationKey(ownerUserId, creationKey);
      if (!concurrent) throw error;
      return { conversation: this.serializeConversation(concurrent) };
    }
  }

  async listConversations(ownerUserId: string, cursorValue?: unknown) {
    const cutoff = new Date(Date.now() - assistantHistoryDays * 24 * 60 * 60 * 1_000);
    const cursor = this.parseHistoryCursor(cursorValue);
    const conversations = await this.prisma.assistantConversation.findMany({
      where: {
        ownerUserId,
        updatedAt: { gte: cutoff },
        ...(cursor ? {
          OR: [
            { updatedAt: { lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
          ],
        } : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: assistantHistoryPageSize + 1,
      select: conversationSummarySelect,
    });
    const page = conversations.slice(0, assistantHistoryPageSize);

    return {
      items: page.map((conversation) => this.serializeConversationSummary(conversation)),
      nextCursor: conversations.length > assistantHistoryPageSize && page.length > 0
        ? this.encodeHistoryCursor(page[page.length - 1]!)
        : null,
    };
  }

  async getConversation(conversationId: string, ownerUserId: string) {
    const normalizedConversationId = this.parseUuid(conversationId, 'conversationId');
    const conversation = await this.prisma.assistantConversation.findFirst({
      where: { id: normalizedConversationId, ownerUserId },
      include: conversationDetailInclude,
    });

    if (!conversation) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');
    return { conversation: this.serializeConversation(conversation) };
  }

  async startRun(input: {
    conversationId: string;
    ownerUserId: string;
    idempotencyKey: unknown;
    body: unknown;
  }) {
    const conversationId = this.parseUuid(input.conversationId, 'conversationId');
    const idempotencyKey = this.parseUuid(input.idempotencyKey, 'Idempotency-Key');
    const messageInput = this.parseMessageInput(input.body);
    const requestHash = this.hashRequest(conversationId, messageInput);
    const existing = await this.findRunByIdempotencyKey(input.ownerUserId, idempotencyKey);

    if (existing) return this.replayExistingRun(existing, conversationId, requestHash);

    let transactionResult: { run: StoredRun; created: boolean };
    try {
      transactionResult = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "assistant_conversations"
          WHERE "id" = ${conversationId}::uuid
          FOR UPDATE
        `);
        const concurrent = await transaction.assistantRun.findUnique({
          where: {
            ownerUserId_idempotencyKey: {
              ownerUserId: input.ownerUserId,
              idempotencyKey,
            },
          },
          include: runInclude,
        });
        if (concurrent) return { run: concurrent, created: false };

        const conversation = await transaction.assistantConversation.findFirst({
          where: { id: conversationId, ownerUserId: input.ownerUserId },
          select: {
            id: true,
            title: true,
            _count: { select: { messages: true } },
          },
        });
        if (!conversation) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');
        if (conversation._count.messages + 2 > assistantConversationMessageLimit) {
          throw new ConflictException('ASSISTANT_CONVERSATION_MESSAGE_LIMIT_REACHED');
        }

        const userMessage = await transaction.assistantMessage.create({
          data: {
            conversationId,
            role: PrismaAssistantMessageRole.USER,
            content: messageInput.content,
            contextJson: messageInput.context
              ? messageInput.context as unknown as Prisma.InputJsonValue
              : Prisma.JsonNull,
          },
        });
        const createdRun = await transaction.assistantRun.create({
          data: {
            ownerUserId: input.ownerUserId,
            conversationId,
            userMessageId: userMessage.id,
            idempotencyKey,
            requestHash,
          },
          include: runInclude,
        });
        await transaction.assistantConversation.update({
          where: { id: conversationId },
          data: {
            title: conversation.title === 'Новый разговор'
              ? this.buildConversationTitle(messageInput.content)
              : conversation.title,
          },
        });

        return { run: createdRun, created: true };
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.findRunByIdempotencyKey(input.ownerUserId, idempotencyKey);
      if (!concurrent) throw error;
      return this.replayExistingRun(concurrent, conversationId, requestHash);
    }

    if (!transactionResult.created) {
      return this.replayExistingRun(transactionResult.run, conversationId, requestHash);
    }

    const run = transactionResult.run;
    this.runProcessor.queueRun(run.id);
    return { run: this.serializeRun(run) };
  }

  async getRun(runId: string, ownerUserId: string) {
    const normalizedRunId = this.parseUuid(runId, 'runId');
    const run = await this.prisma.assistantRun.findFirst({
      where: { id: normalizedRunId, ownerUserId },
      include: runInclude,
    });

    if (!run) throw new NotFoundException('ASSISTANT_RUN_NOT_FOUND');
    return { run: this.serializeRun(run) };
  }

  private async replayExistingRun(existing: StoredRun, conversationId: string, requestHash: string) {
    if (existing.conversationId !== conversationId || existing.requestHash !== requestHash) {
      throw new ConflictException('ASSISTANT_IDEMPOTENCY_KEY_REUSED');
    }

    if (existing.status === PrismaAssistantRunStatus.FAILED) {
      await this.prisma.assistantRun.updateMany({
        where: { id: existing.id, status: PrismaAssistantRunStatus.FAILED },
        data: {
          status: PrismaAssistantRunStatus.PENDING,
          progressJson: [],
          intentJson: Prisma.DbNull,
          evidenceJson: [],
          telemetryJson: [],
          errorCode: null,
          startedAt: null,
          completedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
    }

    const run = await this.prisma.assistantRun.findUniqueOrThrow({
      where: { id: existing.id },
      include: runInclude,
    });
    if (run.status === PrismaAssistantRunStatus.PENDING) this.runProcessor.queueRun(run.id);
    return { run: this.serializeRun(run) };
  }

  private findConversationByCreationKey(ownerUserId: string, creationKey: string) {
    return this.prisma.assistantConversation.findUnique({
      where: { ownerUserId_creationKey: { ownerUserId, creationKey } },
      include: conversationDetailInclude,
    });
  }

  private findRunByIdempotencyKey(ownerUserId: string, idempotencyKey: string) {
    return this.prisma.assistantRun.findUnique({
      where: { ownerUserId_idempotencyKey: { ownerUserId, idempotencyKey } },
      include: runInclude,
    });
  }

  private parseMessageInput(value: unknown): AssistantSendMessageInput {
    if (!this.isRecord(value)) throw new BadRequestException('ASSISTANT_MESSAGE_INVALID');
    const content = this.parseString(value.content, 'content', assistantMessageMaxLength);
    const context = value.context === undefined || value.context === null
      ? null
      : this.parseContext(value.context);
    return { content, context };
  }

  private parseContext(value: unknown): AssistantPageContext {
    if (!this.isRecord(value)) throw new BadRequestException('ASSISTANT_CONTEXT_INVALID');
    const kind = this.parseString(value.kind, 'context.kind', 32);
    if (!contextKinds.has(kind)) throw new BadRequestException('ASSISTANT_CONTEXT_KIND_INVALID');

    return {
      kind: kind as AssistantPageContext['kind'],
      key: this.parseString(value.key, 'context.key', assistantContextKeyMaxLength),
      label: this.parseString(value.label, 'context.label', assistantContextLabelMaxLength),
    };
  }

  private parseHistoryCursor(value: unknown): AssistantHistoryCursor | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > assistantHistoryCursorMaxLength) {
      throw new BadRequestException('ASSISTANT_HISTORY_CURSOR_INVALID');
    }

    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
      if (!this.isRecord(parsed)) throw new Error('invalid');
      const id = this.parseUuid(parsed.id, 'cursor.id');
      if (typeof parsed.updatedAt !== 'string') throw new Error('invalid');
      const updatedAt = new Date(parsed.updatedAt);
      if (Number.isNaN(updatedAt.getTime())) throw new Error('invalid');
      return { id, updatedAt };
    } catch {
      throw new BadRequestException('ASSISTANT_HISTORY_CURSOR_INVALID');
    }
  }

  private encodeHistoryCursor(conversation: Pick<StoredConversationSummary, 'id' | 'updatedAt'>) {
    return Buffer.from(JSON.stringify({
      id: conversation.id,
      updatedAt: conversation.updatedAt.toISOString(),
    }), 'utf8').toString('base64url');
  }

  private parseString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const normalized = value.trim().replace(/\s+/gu, ' ');
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return normalized;
  }

  private parseUuid(value: unknown, field: string) {
    if (typeof value !== 'string' || !uuidPattern.test(value)) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return value;
  }

  private hashRequest(conversationId: string, input: AssistantSendMessageInput) {
    return createHash('sha256')
      .update(JSON.stringify({ conversationId, content: input.content, context: input.context ?? null }))
      .digest('hex');
  }

  private buildConversationTitle(content: string) {
    return content.length <= assistantConversationTitleMaxLength
      ? content
      : `${content.slice(0, assistantConversationTitleMaxLength - 1).trimEnd()}…`;
  }

  private serializeConversationSummary(conversation: StoredConversationSummary): AssistantConversationSummary {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messagesCount: conversation._count.messages,
    };
  }

  private serializeConversation(conversation: StoredConversation): AssistantConversation {
    return {
      ...this.serializeConversationSummary(conversation),
      messages: conversation.messages.map((message) => this.serializeMessage(message)),
    };
  }

  private serializeMessage(message: StoredMessage): AssistantMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      context: this.parseStoredContext(message.contextJson),
      answer: message.role === PrismaAssistantMessageRole.ASSISTANT
        ? this.parseStoredAnswer(message.answerJson)
        : null,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private serializeRun(run: StoredRun): AssistantRun {
    return {
      id: run.id,
      conversationId: run.conversationId,
      status: run.status,
      progressEvents: this.parseProgressEvents(run.progressJson),
      assistantMessage: run.assistantMessage ? this.serializeMessage(run.assistantMessage) : null,
      errorCode: run.errorCode,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }

  private parseStoredContext(value: Prisma.JsonValue | null): AssistantPageContext | null {
    try {
      return value === null ? null : this.parseContext(value);
    } catch {
      return null;
    }
  }

  private parseStoredAnswer(value: Prisma.JsonValue | null): AssistantAnswer | null {
    if (!this.isRecord(value) || typeof value.kind !== 'string' || !answerKinds.has(value.kind)) return null;
    if (value.kind !== 'SEARCH_RESULTS') return { kind: value.kind } as AssistantAnswer;
    if (!Array.isArray(value.exactResults) || !Array.isArray(value.alternatives)) return null;
    if (value.exactResults.length > 3 || value.alternatives.length > 2) return null;

    const exactResults = value.exactResults.flatMap((item) => {
      const parsed = this.parseStoredResultCard(item, false);
      return parsed ? [parsed] : [];
    });
    const alternatives = value.alternatives.flatMap((item) => {
      const parsed = this.parseStoredResultCard(item, true);
      return parsed ? [parsed] : [];
    });
    if (exactResults.length !== value.exactResults.length || alternatives.length !== value.alternatives.length) return null;
    if (exactResults.length > 0 && alternatives.length > 0) return null;
    return { kind: 'SEARCH_RESULTS', exactResults, alternatives };
  }

  private parseStoredResultCard(value: unknown, alternative: boolean): AssistantSearchResultCard | null {
    if (!this.isRecord(value)) return null;
    if (
      typeof value.unitId !== 'string' || !uuidPattern.test(value.unitId) ||
      typeof value.title !== 'string' || !this.isBoundedText(value.title, 300) ||
      typeof value.subtitle !== 'string' || !this.isBoundedText(value.subtitle, 300) ||
      typeof value.priceRub !== 'number' || !Number.isFinite(value.priceRub) || value.priceRub <= 0 ||
      typeof value.availabilityLabel !== 'string' || !this.isBoundedText(value.availabilityLabel, 80) ||
      typeof value.freshnessLabel !== 'string' || !this.isBoundedText(value.freshnessLabel, 160) ||
      typeof value.isStale !== 'boolean' ||
      typeof value.href !== 'string' || !this.isExistingLotHref(value.href, value.unitId) ||
      !Array.isArray(value.facts) || value.facts.length > 8 ||
      !Array.isArray(value.pdfs) || value.pdfs.length > 4 ||
      !Array.isArray(value.deviations)
    ) return null;
    const facts = value.facts.flatMap((fact) =>
      typeof fact === 'string' && this.isBoundedText(fact, 240) ? [fact] : []);
    const pdfs = value.pdfs.flatMap((pdf) => {
      if (!this.isRecord(pdf) || typeof pdf.title !== 'string' || !this.isBoundedText(pdf.title, 240)) return [];
      if (typeof pdf.href !== 'string' || !/^\/media\/files\/[0-9a-f-]{36}\/content\?download=true$/iu.test(pdf.href)) return [];
      return [{ title: pdf.title, href: pdf.href }];
    });
    const deviations = value.deviations.flatMap((deviation) => {
      if (!this.isRecord(deviation) || typeof deviation.type !== 'string' || !deviationTypes.has(deviation.type)) return [];
      if (typeof deviation.label !== 'string' || !this.isBoundedText(deviation.label, 240)) return [];
      return [{
        type: deviation.type as AssistantSearchResultCard['deviations'][number]['type'],
        label: deviation.label,
      }];
    });
    if (facts.length !== value.facts.length || pdfs.length !== value.pdfs.length) return null;
    if (deviations.length !== value.deviations.length || deviations.length !== (alternative ? 1 : 0)) return null;
    return {
      unitId: value.unitId,
      title: value.title,
      subtitle: value.subtitle,
      priceRub: value.priceRub,
      availabilityLabel: value.availabilityLabel,
      freshnessLabel: value.freshnessLabel,
      isStale: value.isStale,
      href: value.href,
      facts,
      pdfs,
      deviations,
    };
  }

  private isExistingLotHref(value: string, unitId: string) {
    return new RegExp(`^/objects/[^/]+/lots/${unitId}$`, 'u').test(value);
  }

  private isBoundedText(value: string, maximumLength: number) {
    return value.trim().length > 0 && value.length <= maximumLength;
  }

  private parseProgressEvents(value: Prisma.JsonValue): AssistantProgressEvent[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!this.isRecord(entry)) return [];
      if (
        typeof entry.step !== 'string' ||
        !assistantProgressDefinitions.some(({ step }) => step === entry.step) ||
        typeof entry.label !== 'string' ||
        typeof entry.createdAt !== 'string'
      ) return [];
      return [{
        step: entry.step as AssistantProgressStep,
        label: entry.label,
        createdAt: entry.createdAt,
      }];
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

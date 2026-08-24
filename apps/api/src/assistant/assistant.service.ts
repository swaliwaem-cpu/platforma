import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  AssistantMessageRole as PrismaAssistantMessageRole,
  AssistantRunStatus as PrismaAssistantRunStatus,
  Prisma,
} from '@prisma/client';
import type {
  AssistantConversation,
  AssistantConversationSummary,
  AssistantMessage,
  AssistantPageContext,
  AssistantProgressEvent,
  AssistantProgressStep,
  AssistantRun,
  AssistantSendMessageInput,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

const assistantHistoryDays = 30;
const assistantHistoryLimit = 50;
const assistantMessageMaxLength = 4_000;
const assistantContextKeyMaxLength = 512;
const assistantContextLabelMaxLength = 160;
const assistantConversationTitleMaxLength = 80;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const contextKinds = new Set(['OBJECT', 'LOT', 'DEVELOPER', 'CATALOG_FILTERS']);
const progressDefinitions: readonly { step: AssistantProgressStep; label: string }[] = [
  { step: 'UNDERSTANDING', label: 'Понимаю запрос' },
  { step: 'SEARCHING', label: 'Ищу данные' },
  { step: 'COMPARING', label: 'Сравниваю варианты' },
  { step: 'ANSWERING', label: 'Формирую ответ' },
];

const runInclude = {
  assistantMessage: true,
} satisfies Prisma.AssistantRunInclude;

type StoredRun = Prisma.AssistantRunGetPayload<{ include: typeof runInclude }>;
type StoredMessage = Prisma.AssistantMessageGetPayload<Record<string, never>>;

@Injectable()
export class AssistantService implements OnModuleDestroy {
  private readonly logger = new Logger(AssistantService.name);
  private readonly activeTasks = new Set<Promise<void>>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleDestroy() {
    await Promise.allSettled(this.activeTasks);
  }

  async createConversation(ownerUserId: string) {
    const conversation = await this.prisma.assistantConversation.create({
      data: { ownerUserId },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        _count: { select: { messages: true } },
      },
    });

    return { conversation: this.serializeConversation(conversation) };
  }

  async listConversations(ownerUserId: string) {
    const cutoff = new Date(Date.now() - assistantHistoryDays * 24 * 60 * 60 * 1_000);
    const conversations = await this.prisma.assistantConversation.findMany({
      where: { ownerUserId, updatedAt: { gte: cutoff } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: assistantHistoryLimit,
      include: { _count: { select: { messages: true } } },
    });

    return {
      items: conversations.map((conversation) => this.serializeConversationSummary(conversation)),
    };
  }

  async getConversation(conversationId: string, ownerUserId: string) {
    const normalizedConversationId = this.parseUuid(conversationId, 'conversationId');
    const conversation = await this.prisma.assistantConversation.findFirst({
      where: { id: normalizedConversationId, ownerUserId },
      include: {
        messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        _count: { select: { messages: true } },
      },
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

    let run: StoredRun;
    try {
      run = await this.prisma.$transaction(async (transaction) => {
        const conversation = await transaction.assistantConversation.findFirst({
          where: { id: conversationId, ownerUserId: input.ownerUserId },
          select: { id: true, title: true },
        });
        if (!conversation) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');

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

        return createdRun;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.findRunByIdempotencyKey(input.ownerUserId, idempotencyKey);
      if (!concurrent) throw error;
      return this.replayExistingRun(concurrent, conversationId, requestHash);
    }

    this.queueRun(run.id);
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

    let run = existing;
    if (existing.status === PrismaAssistantRunStatus.FAILED) {
      const retried = await this.prisma.assistantRun.updateMany({
        where: { id: existing.id, status: PrismaAssistantRunStatus.FAILED },
        data: {
          status: PrismaAssistantRunStatus.PENDING,
          progressJson: [],
          errorCode: null,
          startedAt: null,
          completedAt: null,
        },
      });
      if (retried.count === 1) {
        run = await this.prisma.assistantRun.findUniqueOrThrow({
          where: { id: existing.id },
          include: runInclude,
        });
      }
    }

    if (run.status === PrismaAssistantRunStatus.PENDING) this.queueRun(run.id);
    return { run: this.serializeRun(run) };
  }

  private findRunByIdempotencyKey(ownerUserId: string, idempotencyKey: string) {
    return this.prisma.assistantRun.findUnique({
      where: { ownerUserId_idempotencyKey: { ownerUserId, idempotencyKey } },
      include: runInclude,
    });
  }

  private queueRun(runId: string) {
    const task = Promise.resolve()
      .then(() => this.executeRun(runId))
      .finally(() => this.activeTasks.delete(task));
    this.activeTasks.add(task);
  }

  private async executeRun(runId: string) {
    const claimed = await this.prisma.assistantRun.updateMany({
      where: { id: runId, status: PrismaAssistantRunStatus.PENDING },
      data: { status: PrismaAssistantRunStatus.RUNNING, startedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    try {
      const run = await this.prisma.assistantRun.findUniqueOrThrow({
        where: { id: runId },
        include: { userMessage: true },
      });
      const events: AssistantProgressEvent[] = [];
      const delayMs = this.getFakeStepDelayMs();

      for (const definition of progressDefinitions) {
        events.push({ ...definition, createdAt: new Date().toISOString() });
        await this.prisma.assistantRun.update({
          where: { id: runId },
          data: { progressJson: events as unknown as Prisma.InputJsonValue },
        });
        if (delayMs > 0) await this.delay(delayMs);
      }

      const content = `Тестовый помощник получил запрос: «${run.userMessage.content}».`;
      await this.prisma.$transaction(async (transaction) => {
        const assistantMessage = await transaction.assistantMessage.create({
          data: {
            conversationId: run.conversationId,
            role: PrismaAssistantMessageRole.ASSISTANT,
            content,
          },
        });
        await transaction.assistantRun.update({
          where: { id: runId },
          data: {
            status: PrismaAssistantRunStatus.COMPLETED,
            assistantMessageId: assistantMessage.id,
            completedAt: new Date(),
          },
        });
        await transaction.assistantConversation.update({
          where: { id: run.conversationId },
          data: { updatedAt: new Date() },
        });
      });
    } catch {
      this.logger.error(`Assistant fake run failed: ${runId}`);
      await this.prisma.assistantRun.updateMany({
        where: { id: runId, status: PrismaAssistantRunStatus.RUNNING },
        data: {
          status: PrismaAssistantRunStatus.FAILED,
          errorCode: 'ASSISTANT_FAKE_RUN_FAILED',
          completedAt: new Date(),
        },
      });
    }
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

  private getFakeStepDelayMs() {
    const raw = process.env.ASSISTANT_FAKE_STEP_DELAY_MS;
    const value = raw === undefined || raw === '' ? 120 : Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 2_000) return 120;
    return value;
  }

  private delay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private serializeConversationSummary(conversation: {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    _count: { messages: number };
  }): AssistantConversationSummary {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messagesCount: conversation._count.messages,
    };
  }

  private serializeConversation(conversation: {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
    messages: StoredMessage[];
    _count: { messages: number };
  }): AssistantConversation {
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

  private parseProgressEvents(value: Prisma.JsonValue): AssistantProgressEvent[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!this.isRecord(entry)) return [];
      if (
        typeof entry.step !== 'string' ||
        !progressDefinitions.some(({ step }) => step === entry.step) ||
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

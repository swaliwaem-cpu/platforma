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
  AssistantExternalLotCard,
  AssistantFeedback,
  AssistantGeoConstraintView,
  AssistantGeoSearchContext,
  AssistantGeoSearchSelection,
  AssistantGeoSearchView,
  AssistantGeoView,
  AssistantKnowledgeFactCard,
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
  parseAssistantGeoBrowserContext,
  parseAssistantGeoStoredContext,
  parseAssistantGeoStoredValue,
  parseAssistantReferenceGeometry,
} from './geo/assistant-geo-contract';
import { AssistantGeoLandmarkService } from './geo/assistant-geo-landmark.service';
import {
  AssistantRunProcessor,
  assistantProgressDefinitions,
} from './assistant-run.processor';
import { isSafeOfficialHttpsUrl } from './sources/assistant-knowledge-policy';

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
const answerKinds = new Set(['SEARCH_RESULTS', 'KNOWLEDGE_RESULTS', 'CLARIFICATION', 'REFUSAL', 'SAFE_BOUNDARY']);
const deviationTypes = new Set(['BUDGET', 'DISTRICT', 'DEVELOPER', 'ROOMS']);

const messageSelect = {
  id: true,
  role: true,
  content: true,
  contextJson: true,
  geoContextJson: true,
  answerJson: true,
  assistantRun: {
    select: {
      feedback: {
        select: {
          id: true,
          rating: true,
          reason: true,
          comment: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  },
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
type ParsedAssistantSendMessageInput = AssistantSendMessageInput & { requestHashGeo: unknown };

@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runProcessor: AssistantRunProcessor,
    private readonly geoLandmarks: AssistantGeoLandmarkService,
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

    const ownedConversation = await this.prisma.assistantConversation.findFirst({
      where: { id: conversationId, ownerUserId: input.ownerUserId },
      select: { id: true },
    });
    if (!ownedConversation) throw new NotFoundException('ASSISTANT_CONVERSATION_NOT_FOUND');
    const canonicalGeo = messageInput.geo
      ? await this.geoLandmarks.materializeBrowserContext(messageInput.geo)
      : null;

    let transactionResult: { run: StoredRun; created: boolean };
    try {
      transactionResult = await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(Prisma.sql`
          SELECT "id"
          FROM "assistant_conversations"
          WHERE "id" = ${conversationId}::uuid
            AND "owner_user_id" = ${input.ownerUserId}::uuid
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
            geoContextJson: canonicalGeo
              ? canonicalGeo as unknown as Prisma.InputJsonValue
              : Prisma.DbNull,
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
          auditJson: {},
          qualityFlags: [],
          latencyMs: null,
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

  private parseMessageInput(value: unknown): ParsedAssistantSendMessageInput {
    if (!this.isRecord(value)) throw new BadRequestException('ASSISTANT_MESSAGE_INVALID');
    const content = this.parseString(value.content, 'content', assistantMessageMaxLength);
    const context = value.context === undefined || value.context === null
      ? null
      : this.parseContext(value.context);
    const geo = value.geo === undefined || value.geo === null
      ? null
      : parseAssistantGeoBrowserContext(value.geo);
    const requestHashGeo = geo && !('operator' in geo) && geo.referenceType === 'MANUAL_POINT'
      && this.isRecord(value.geo)
      && this.isRecord(value.geo.anchor)
      ? {
          anchor: {
            latitude: geo.point.latitude,
            longitude: geo.point.longitude,
            label: geo.point.label,
            source: 'MANUAL',
          },
          radiusMeters: geo.distanceMeters,
        }
      : geo;
    return { content, context, geo, requestHashGeo };
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

  private hashRequest(conversationId: string, input: ParsedAssistantSendMessageInput) {
    return createHash('sha256')
      .update(JSON.stringify({
        conversationId,
        content: input.content,
        context: input.context ?? null,
        geo: input.requestHashGeo ?? null,
      }))
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
      geo: this.parseStoredGeoContext(message.geoContextJson),
      answer: message.role === PrismaAssistantMessageRole.ASSISTANT
        ? this.parseStoredAnswer(message.answerJson)
        : null,
      feedback: message.assistantRun?.feedback
        ? this.serializeFeedback(message.assistantRun.feedback)
        : null,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private serializeFeedback(
    feedback: NonNullable<NonNullable<StoredMessage['assistantRun']>['feedback']>,
  ): AssistantFeedback {
    return {
      id: feedback.id,
      rating: feedback.rating,
      reason: feedback.reason,
      comment: feedback.comment,
      createdAt: feedback.createdAt.toISOString(),
      updatedAt: feedback.updatedAt.toISOString(),
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

  private parseStoredGeoContext(value: Prisma.JsonValue | null): AssistantGeoSearchSelection | null {
    try {
      return value === null ? null : parseAssistantGeoStoredValue(value, {
        ASSISTANT_GEO_RADIUS_MIN_METERS: '1',
        ASSISTANT_GEO_RADIUS_MAX_METERS: '100000',
      });
    } catch {
      return null;
    }
  }

  private parseStoredAnswer(value: Prisma.JsonValue | null): AssistantAnswer | null {
    if (!this.isRecord(value) || typeof value.kind !== 'string' || !answerKinds.has(value.kind)) return null;
    if (value.kind === 'KNOWLEDGE_RESULTS') return this.parseStoredKnowledgeAnswer(value);
    if (value.kind !== 'SEARCH_RESULTS') return { kind: value.kind } as AssistantAnswer;
    if (!Array.isArray(value.exactResults) || !Array.isArray(value.alternatives)) return null;
    if (value.exactResults.length > 3 || value.alternatives.length > 2) return null;
    const hasTotalExactResults = value.totalExactResults !== undefined;
    const hasAdditionalExactResults = value.additionalExactResults !== undefined;
    if (hasTotalExactResults !== hasAdditionalExactResults) return null;
    if (hasAdditionalExactResults
      && (!Array.isArray(value.additionalExactResults) || value.additionalExactResults.length > 5)) return null;

    const exactResults = value.exactResults.flatMap((item) => {
      const parsed = this.parseStoredResultCard(item, false);
      return parsed ? [parsed] : [];
    });
    const additionalExactResults = hasAdditionalExactResults
      ? (value.additionalExactResults as unknown[]).flatMap((item) => {
          const parsed = this.parseStoredResultCard(item, false);
          return parsed ? [parsed] : [];
        })
      : [];
    const alternatives = value.alternatives.flatMap((item) => {
      const parsed = this.parseStoredResultCard(item, true);
      return parsed ? [parsed] : [];
    });
    if (exactResults.length !== value.exactResults.length
      || (hasAdditionalExactResults
        && additionalExactResults.length !== (value.additionalExactResults as unknown[]).length)
      || alternatives.length !== value.alternatives.length) return null;
    if ((exactResults.length > 0 || additionalExactResults.length > 0) && alternatives.length > 0) return null;
    let totalExactResults: number | undefined;
    if (hasTotalExactResults) {
      if (!Number.isSafeInteger(value.totalExactResults) || (value.totalExactResults as number) < 0) return null;
      totalExactResults = value.totalExactResults as number;
      if (exactResults.length !== Math.min(totalExactResults, 3)
        || additionalExactResults.length !== Math.min(5, Math.max(totalExactResults - 3, 0))
        || (alternatives.length > 0 && totalExactResults !== 0)) return null;
      const resultIds = [
        ...exactResults,
        ...additionalExactResults,
        ...alternatives,
      ].map(({ unitId }) => unitId);
      if (new Set(resultIds).size !== resultIds.length) return null;
    }
    const geo = value.geo === undefined ? undefined : this.parseStoredGeoView(value.geo);
    if (value.geo !== undefined && !geo) return null;
    if (geo && !this.geoMarkersMatchResults(geo, exactResults, alternatives)) return null;
    if (geo && !this.geoResultsMatchConstraint(
      geo,
      [...exactResults, ...additionalExactResults, ...alternatives],
    )) return null;
    if (totalExactResults === undefined) {
      return {
        kind: 'SEARCH_RESULTS',
        exactResults,
        alternatives,
        ...(geo ? { geo } : {}),
      };
    }
    return {
      kind: 'SEARCH_RESULTS',
      totalExactResults,
      exactResults,
      additionalExactResults,
      alternatives,
      ...(geo ? { geo } : {}),
    };
  }

  private parseStoredGeoView(value: unknown): AssistantGeoView | null {
    if (!this.isRecord(value)) return null;
    if (value.operator === 'ALL') return this.parseStoredCompositeGeoView(value);
    const legacy = this.isRecord(value.anchor) && typeof value.radiusMeters === 'number';
    const contextValue = legacy
      ? { anchor: value.anchor, radiusMeters: value.radiusMeters }
      : extractCanonicalGeoContext(value);
    let context: AssistantGeoSearchContext;
    try {
      context = parseAssistantGeoStoredContext(contextValue, {
        ASSISTANT_GEO_RADIUS_MIN_METERS: '1',
        ASSISTANT_GEO_RADIUS_MAX_METERS: '100000',
      });
    } catch {
      return null;
    }
    if (!context || !Array.isArray(value.markers) || value.markers.length > 5) return null;
    let referenceGeometry: AssistantGeoSearchView['referenceGeometry'];
    let searchArea: AssistantGeoSearchView['searchArea'];
    try {
      referenceGeometry = legacy
        ? parseAssistantReferenceGeometry({
            type: 'Point',
            coordinates: [context.kind === 'POINT' ? context.point.longitude : 0, context.kind === 'POINT' ? context.point.latitude : 0],
          }, 'POINT')
        : parseAssistantReferenceGeometry(value.referenceGeometry, context.kind);
      searchArea = parseAssistantReferenceGeometry(
        legacy ? value.polygon : value.searchArea,
        'AREA',
      ) as AssistantGeoSearchView['searchArea'];
    } catch {
      return null;
    }
    const markers = value.markers.flatMap((marker) => {
      if (!this.isRecord(marker)
        || typeof marker.unitId !== 'string' || !uuidPattern.test(marker.unitId)
        || typeof marker.latitude !== 'number' || !Number.isFinite(marker.latitude)
        || marker.latitude < -90 || marker.latitude > 90
        || typeof marker.longitude !== 'number' || !Number.isFinite(marker.longitude)
        || marker.longitude < -180 || marker.longitude > 180
        || (context.mode === 'NEAR' && (typeof marker.distanceMeters !== 'number'
          || !Number.isFinite(marker.distanceMeters)
          || marker.distanceMeters < 0
          || marker.distanceMeters > context.distanceMeters + 2))
        || (context.mode === 'INSIDE' && marker.distanceMeters !== undefined)
        || (marker.kind !== 'PRIMARY' && marker.kind !== 'ALTERNATIVE')) return [];
      return [{
        unitId: marker.unitId,
        latitude: marker.latitude,
        longitude: marker.longitude,
        ...(context.mode === 'NEAR' ? { distanceMeters: marker.distanceMeters as number } : {}),
        kind: marker.kind as 'PRIMARY' | 'ALTERNATIVE',
      }];
    });
    if (markers.length !== value.markers.length) return null;
    return {
      ...context,
      referenceGeometry,
      searchArea,
      markers,
    } as AssistantGeoSearchView;
  }

  private parseStoredCompositeGeoView(value: Record<string, unknown>): AssistantGeoView | null {
    if (!Array.isArray(value.constraints) || !Array.isArray(value.markers) || value.markers.length > 5) {
      return null;
    }
    const rawConstraints = value.constraints;
    const context = this.parseStoredGeoContext({
      operator: 'ALL',
      constraints: rawConstraints.map((constraint) => this.isRecord(constraint)
        ? extractCanonicalGeoContext(constraint)
        : constraint as Prisma.JsonValue),
    });
    if (!context || !('operator' in context) || context.constraints.length !== rawConstraints.length) return null;
    const constraints = context.constraints.flatMap((constraint, index) => {
      const raw = rawConstraints[index];
      if (!this.isRecord(raw)) return [];
      let referenceGeometry: AssistantGeoConstraintView['referenceGeometry'];
      let searchArea: AssistantGeoConstraintView['searchArea'];
      try {
        referenceGeometry = parseAssistantReferenceGeometry(raw.referenceGeometry, constraint.kind);
        searchArea = parseAssistantReferenceGeometry(raw.searchArea, 'AREA') as AssistantGeoConstraintView['searchArea'];
      } catch {
        return [];
      }
      return [{ ...constraint, referenceGeometry, searchArea } as AssistantGeoConstraintView];
    });
    if (constraints.length !== context.constraints.length) return null;
    const markers = value.markers.flatMap((marker) => {
      if (!this.isRecord(marker)
        || typeof marker.unitId !== 'string' || !uuidPattern.test(marker.unitId)
        || typeof marker.latitude !== 'number' || !Number.isFinite(marker.latitude)
        || marker.latitude < -90 || marker.latitude > 90
        || typeof marker.longitude !== 'number' || !Number.isFinite(marker.longitude)
        || marker.longitude < -180 || marker.longitude > 180
        || marker.distanceMeters !== undefined
        || (marker.kind !== 'PRIMARY' && marker.kind !== 'ALTERNATIVE')) return [];
      return [{
        unitId: marker.unitId,
        latitude: marker.latitude,
        longitude: marker.longitude,
        kind: marker.kind as 'PRIMARY' | 'ALTERNATIVE',
      }];
    });
    if (markers.length !== value.markers.length) return null;
    return { operator: 'ALL', constraints, markers };
  }

  private geoMarkersMatchResults(
    geo: AssistantGeoView,
    exactResults: AssistantSearchResultCard[],
    alternatives: AssistantSearchResultCard[],
  ) {
    const expected = new Map([
      ...exactResults.map((result) => [result.unitId, 'PRIMARY'] as const),
      ...alternatives.map((result) => [result.unitId, 'ALTERNATIVE'] as const),
    ]);
    const markerIds = geo.markers.map(({ unitId }) => unitId);
    return geo.markers.length === expected.size
      && new Set(markerIds).size === markerIds.length
      && geo.markers.every((marker) => expected.get(marker.unitId) === marker.kind)
      && [...expected.keys()].every((unitId) => markerIds.includes(unitId))
      && [...exactResults, ...alternatives].every((result) =>
        'operator' in geo
          ? result.distanceMeters === undefined
          : geo.mode === 'INSIDE'
          ? result.distanceMeters === undefined
          : typeof result.distanceMeters === 'number'
            && geo.markers.some((marker) => marker.unitId === result.unitId
              && typeof marker.distanceMeters === 'number'
              && Math.abs(marker.distanceMeters - result.distanceMeters!) < 0.01));
  }

  private geoResultsMatchConstraint(
    geo: AssistantGeoView,
    results: AssistantSearchResultCard[],
  ) {
    if ('operator' in geo) return results.every((result) => result.distanceMeters === undefined);
    return results.every((result) => geo.mode === 'INSIDE'
      ? result.distanceMeters === undefined
      : typeof result.distanceMeters === 'number'
        && result.distanceMeters <= geo.distanceMeters + 2);
  }

  private parseStoredKnowledgeAnswer(value: Record<string, unknown>): AssistantAnswer | null {
    if (!Array.isArray(value.facts) || value.facts.length > 6
      || !Array.isArray(value.externalLots) || value.externalLots.length > 3) return null;
    const facts = value.facts.flatMap((fact) => {
      const parsed = this.parseStoredKnowledgeFact(fact);
      return parsed ? [parsed] : [];
    });
    const externalLots = value.externalLots.flatMap((lot) => {
      const parsed = this.parseStoredExternalLot(lot);
      return parsed ? [parsed] : [];
    });
    if (facts.length !== value.facts.length || externalLots.length !== value.externalLots.length
      || (facts.length === 0 && externalLots.length === 0)) return null;
    return { kind: 'KNOWLEDGE_RESULTS', facts, externalLots };
  }

  private parseStoredKnowledgeFact(value: unknown): AssistantKnowledgeFactCard | null {
    if (!this.isRecord(value)
      || typeof value.id !== 'string' || !uuidPattern.test(value.id)
      || typeof value.label !== 'string' || !this.isBoundedText(value.label, 300)
      || typeof value.value !== 'string' || !this.isBoundedText(value.value, 2_000)
      || typeof value.freshnessLabel !== 'string' || !this.isBoundedText(value.freshnessLabel, 160)
      || typeof value.isStale !== 'boolean') return null;
    return {
      id: value.id,
      label: value.label,
      value: value.value,
      freshnessLabel: value.freshnessLabel,
      isStale: value.isStale,
    };
  }

  private parseStoredExternalLot(value: unknown): AssistantExternalLotCard | null {
    if (!this.isRecord(value)
      || typeof value.id !== 'string' || !uuidPattern.test(value.id)
      || typeof value.title !== 'string' || !this.isBoundedText(value.title, 300)
      || typeof value.subtitle !== 'string' || !this.isBoundedText(value.subtitle, 300)
      || typeof value.priceRub !== 'number' || !Number.isFinite(value.priceRub) || value.priceRub <= 0
      || typeof value.availabilityLabel !== 'string' || !this.isBoundedText(value.availabilityLabel, 120)
      || typeof value.freshnessLabel !== 'string' || !this.isBoundedText(value.freshnessLabel, 160)
      || typeof value.isStale !== 'boolean'
      || typeof value.href !== 'string' || !isSafeOfficialHttpsUrl(value.href)) return null;
    return {
      id: value.id,
      title: value.title,
      subtitle: value.subtitle,
      priceRub: value.priceRub,
      availabilityLabel: value.availabilityLabel,
      freshnessLabel: value.freshnessLabel,
      isStale: value.isStale,
      href: value.href,
    };
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
    const distanceMeters = value.distanceMeters === undefined
      ? undefined
      : typeof value.distanceMeters === 'number' && Number.isFinite(value.distanceMeters) && value.distanceMeters >= 0
        ? value.distanceMeters
        : null;
    if (distanceMeters === null) return null;
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
      ...(distanceMeters === undefined ? {} : { distanceMeters }),
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

function extractCanonicalGeoContext(value: Record<string, unknown>): Prisma.JsonObject {
  const base: Prisma.JsonObject = {
    kind: value.kind as Prisma.JsonValue,
    mode: value.mode as Prisma.JsonValue,
    label: value.label as Prisma.JsonValue,
    source: value.source as Prisma.JsonValue,
  };
  if (value.landmarkId !== undefined) base.landmarkId = value.landmarkId as Prisma.JsonValue;
  if (value.point !== undefined) base.point = value.point as Prisma.JsonValue;
  if (value.distanceMeters !== undefined) base.distanceMeters = value.distanceMeters as Prisma.JsonValue;
  return base;
}

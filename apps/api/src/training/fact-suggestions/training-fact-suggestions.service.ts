import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingFactSuggestionRunStatus,
  TrainingFactSuggestionStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProviderRunStatus,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import type { TrainingAuditRequest } from '../training-content.service';
import { TrainingOpenAiConfig } from '../openai/training-openai.config';
import { TrainingOpenAiRequestError } from '../openai/training-openai.http';
import { lockTrainingVersionForContentMutation } from '../training-version-lock';
import { isTrainingUuid } from '../training-uuid';
import {
  buildTrainingFactSuggestionChunks,
  type TrainingFactSuggestionChunk,
  type TrainingFactSuggestionSourceInput,
} from './training-fact-suggestion.chunking';
import {
  hashTrainingFactSuggestionText,
  serializeTrainingFactSuggestionProviderInput,
  TRAINING_FACT_SUGGESTION_MAX_SUGGESTIONS,
  TRAINING_FACT_SUGGESTION_PROMPT_VERSION,
  TRAINING_FACT_SUGGESTION_SCHEMA_VERSION,
  type TrainingExistingFactInput,
  type TrainingFactSuggestionProviderInput,
} from './training-fact-suggestion.provider';
import { hashCanonicalTrainingFactSuggestionJson as canonicalHash } from './training-fact-suggestion-canonical-json';

const MAX_SOURCES_PER_RUN = 50;
export const TRAINING_FACT_SUGGESTION_MAX_PROVIDER_RUNS_PER_RUN = 40;
export const TRAINING_FACT_SUGGESTION_MAX_AGGREGATE_SUGGESTIONS = 800;
export const TRAINING_FACT_SUGGESTION_MAX_AGGREGATE_INPUT_CHARACTERS =
  1_500_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type SourceKind = 'DOCUMENT' | 'OFFICIAL_URL';

type SourceSnapshot = {
  kind: SourceKind;
  id: string;
  checksum: string;
  contentHash: string;
  chunkCount: number;
};

type PreparedSource = {
  kind: SourceKind;
  id: string;
  checksum: string;
  extractedText: string;
  extractionMetadata: unknown;
  chunks: TrainingFactSuggestionChunk[];
  contentHash: string;
};

type CreateRunInput = {
  sourceIds?: unknown;
};

type InternalCreateRunInput = {
  sourceDocumentIds: string[];
  sourceOfficialUrlIds: string[];
};

type AcceptSuggestionInput = {
  code?: unknown;
  topicCode?: unknown;
  statement?: unknown;
  acceptedAliases?: unknown;
  importance?: unknown;
  questionIds?: unknown;
  comment?: unknown;
};

@Injectable()
export class TrainingFactSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly openAiConfig: TrainingOpenAiConfig,
  ) {}

  async createRun(
    versionIdInput: string,
    body: CreateRunInput,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
    idempotencyKeyInput: unknown,
  ) {
    this.assertOnlyFields(body as Record<string, unknown>, ['sourceIds']);
    const sources = this.parseSourceIds(body.sourceIds);
    return this.createRunInternal(
      versionIdInput,
      {
        sourceDocumentIds: sources
          .filter((source) => source.kind === 'DOCUMENT')
          .map((source) => source.id),
        sourceOfficialUrlIds: sources
          .filter((source) => source.kind === 'OFFICIAL_URL')
          .map((source) => source.id),
      },
      actor,
      request,
      idempotencyKeyInput,
      null,
    );
  }

  async getRun(versionIdInput: string, runIdInput: string) {
    const versionId = this.parseUuid(
      versionIdInput,
      'Training version is invalid',
    );
    const runId = this.parseUuid(runIdInput, 'Fact suggestion run is invalid');
    const run = await this.prisma.trainingFactSuggestionRun.findFirst({
      where: {
        id: runId,
        projectVersionId: versionId,
      },
      include: {
        providerRuns: {
          orderBy: [{ chunkIndex: 'asc' }, { createdAt: 'asc' }],
        },
        suggestions: {
          orderBy: [{ providerRunId: 'asc' }, { suggestionIndex: 'asc' }],
          include: {
            acceptedFact: {
              select: {
                id: true,
                code: true,
                statement: true,
                isApproved: true,
              },
            },
          },
        },
      },
    });
    if (!run) {
      throw new NotFoundException('Fact suggestion run not found');
    }
    return { run: serializeRun(run) };
  }

  async getLatestRun(versionIdInput: string) {
    const versionId = await this.requireVersion(versionIdInput);
    const run = await this.prisma.trainingFactSuggestionRun.findFirst({
      where: { projectVersionId: versionId },
      orderBy: { createdAt: 'desc' },
      include: {
        suggestions: {
          select: { status: true },
        },
      },
    });
    return { run: run ? serializeRun(run) : null };
  }

  async listSuggestions(versionIdInput: string) {
    const versionId = await this.requireVersion(versionIdInput);
    const items = await this.prisma.trainingFactSuggestion.findMany({
      where: {
        projectVersionId: versionId,
      },
      orderBy: [
        { suggestionRun: { createdAt: 'desc' } },
        { providerRunId: 'asc' },
        { suggestionIndex: 'asc' },
      ],
      include: {
        providerRun: {
          select: {
            sourceDocumentId: true,
            sourceOfficialUrlId: true,
          },
        },
      },
    });
    return { items: items.map(serializeSuggestion) };
  }

  async acceptSuggestion(
    versionIdInput: string,
    suggestionIdInput: string,
    body: AcceptSuggestionInput,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    this.assertOnlyFields(body as Record<string, unknown>, [
      'code',
      'topicCode',
      'statement',
      'acceptedAliases',
      'importance',
      'questionIds',
      'comment',
    ]);
    const versionId = this.parseUuid(
      versionIdInput,
      'Training version is invalid',
    );
    const suggestionId = this.parseUuid(
      suggestionIdInput,
      'Fact suggestion is invalid',
    );
    const input = this.parseAcceptInput(body);

    let result: { stale: boolean; factId: string | null };
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
        const lockedVersion = await lockTrainingVersionForContentMutation(
          tx,
          versionId,
        );
        this.assertDraftVersion(lockedVersion?.status);
        if (lockedVersion?.projectStatus === 'ARCHIVED') {
          throw new ConflictException('Archived training project is immutable');
        }
        await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestions" WHERE "id" = ${suggestionId}::uuid FOR UPDATE`;
        const suggestion = await tx.trainingFactSuggestion.findFirst({
          where: {
            id: suggestionId,
            projectVersionId: versionId,
          },
          include: {
            acceptedFact: true,
            providerRun: {
              include: {
                sourceDocument: {
                  select: {
                    id: true,
                    extractedText: true,
                  },
                },
                sourceOfficialUrl: {
                  select: {
                    id: true,
                    extractedText: true,
                  },
                },
              },
            },
          },
        });
        if (!suggestion) {
          throw new NotFoundException('Fact suggestion not found');
        }
        if (
          suggestion.status === TrainingFactSuggestionStatus.ACCEPTED &&
          suggestion.acceptedFact
        ) {
          return {
            stale: false,
            factId: suggestion.acceptedFact.id,
          };
        }
        if (suggestion.status !== TrainingFactSuggestionStatus.PENDING) {
          throw new ConflictException(
            'Only a pending fact suggestion can be accepted',
          );
        }

        let currentText = '';
        if (suggestion.providerRun.sourceDocumentId) {
          await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${suggestion.providerRun.sourceDocumentId}::uuid FOR SHARE`;
          currentText =
            (
              await tx.trainingSourceDocument.findUnique({
                where: { id: suggestion.providerRun.sourceDocumentId },
                select: { extractedText: true },
              })
            )?.extractedText ?? '';
        } else if (suggestion.providerRun.sourceOfficialUrlId) {
          await tx.$queryRaw`SELECT "id" FROM "training_official_url_sources" WHERE "id" = ${suggestion.providerRun.sourceOfficialUrlId}::uuid FOR SHARE`;
          currentText =
            (
              await tx.trainingOfficialUrlSource.findUnique({
                where: { id: suggestion.providerRun.sourceOfficialUrlId },
                select: { extractedText: true },
              })
            )?.extractedText ?? '';
        }
        const currentContentHash = hashTrainingFactSuggestionText(currentText);
        if (
          !currentText.trim() ||
          currentContentHash !== suggestion.sourceContentHash
        ) {
          await tx.trainingFactSuggestion.update({
            where: { id: suggestion.id },
            data: {
              status: TrainingFactSuggestionStatus.STALE,
              reviewedById: actor.id,
              reviewedAt: new Date(),
              reviewComment: 'Source content changed after suggestion generation',
            },
          });
          await this.writeAudit(tx, {
            action: 'training.fact-suggestion.stale',
            actor,
            request,
            entityType: 'training_fact_suggestion',
            entityId: suggestion.id,
            metadata: {
              projectVersionId: versionId,
              suggestionRunId: suggestion.suggestionRunId,
              sourceContentHash: suggestion.sourceContentHash,
              currentContentHash,
            },
          });
          return { stale: true, factId: null };
        }

        await this.ensureQuestionsBelongToVersion(
          tx,
          versionId,
          input.questionIds,
        );
        const fact = await tx.trainingFact.create({
          data: {
            projectVersionId: versionId,
            code: input.code,
            topicCode: input.topicCode,
            statement: input.statement,
            acceptedAliasesJson: input.acceptedAliases,
            importance: input.importance,
            sourceDocumentId:
              suggestion.providerRun.sourceDocumentId ?? undefined,
            sourceOfficialUrlId:
              suggestion.providerRun.sourceOfficialUrlId ?? undefined,
            sourceLocatorJson: requireInputJson(
              suggestion.sourceLocatorJson,
              'Fact suggestion source locator is invalid',
            ),
            isApproved: true,
          },
          select: { id: true },
        });
        if (input.questionIds.length > 0) {
          await tx.trainingQuestionFactLink.createMany({
            data: input.questionIds.map((questionId) => ({
              factId: fact.id,
              questionId,
            })),
            skipDuplicates: true,
          });
        }
        await tx.trainingFactSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: TrainingFactSuggestionStatus.ACCEPTED,
            acceptedFactId: fact.id,
            reviewedById: actor.id,
            reviewedAt: new Date(),
            reviewComment: input.comment,
          },
        });
        await this.writeAudit(tx, {
          action: 'training.fact-suggestion.accept',
          actor,
          request,
          entityType: 'training_fact_suggestion',
          entityId: suggestion.id,
          metadata: {
            projectVersionId: versionId,
            suggestionRunId: suggestion.suggestionRunId,
            acceptedFactId: fact.id,
            questionIds: input.questionIds,
          },
        });
        return { stale: false, factId: fact.id };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        throw new ConflictException(
          'Факт с таким кодом уже существует. Укажите другой код или отклоните предложение.',
        );
      }
      throw error;
    }

    if (result.stale) {
      throw new ConflictException(
        'Source content changed; generate fact suggestions again',
      );
    }
    const fact = await this.prisma.trainingFact.findUnique({
      where: { id: result.factId! },
      include: {
        questionLinks: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const suggestion = await this.getSuggestion(versionId, suggestionId);
    return { suggestion: suggestion.suggestion, fact };
  }

  async rejectSuggestion(
    versionIdInput: string,
    suggestionIdInput: string,
    body: { reason?: unknown },
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    this.assertOnlyFields(body as Record<string, unknown>, ['reason']);
    const versionId = this.parseUuid(
      versionIdInput,
      'Training version is invalid',
    );
    const suggestionId = this.parseUuid(
      suggestionIdInput,
      'Fact suggestion is invalid',
    );
    const reason = this.parseRequiredString(
      body.reason,
      'Rejection comment is required',
      2_000,
      3,
    );

    await this.prisma.$transaction(
      async (tx) => {
        const lockedVersion = await lockTrainingVersionForContentMutation(
          tx,
          versionId,
        );
        this.assertDraftVersion(lockedVersion?.status);
        if (lockedVersion?.projectStatus === 'ARCHIVED') {
          throw new ConflictException('Archived training project is immutable');
        }
        await tx.$queryRaw`SELECT "id" FROM "training_fact_suggestions" WHERE "id" = ${suggestionId}::uuid FOR UPDATE`;
        const suggestion = await tx.trainingFactSuggestion.findFirst({
          where: {
            id: suggestionId,
            projectVersionId: versionId,
          },
        });
        if (!suggestion) {
          throw new NotFoundException('Fact suggestion not found');
        }
        if (suggestion.status === TrainingFactSuggestionStatus.REJECTED) {
          return;
        }
        if (suggestion.status !== TrainingFactSuggestionStatus.PENDING) {
          throw new ConflictException(
            'Only a pending fact suggestion can be rejected',
          );
        }
        await tx.trainingFactSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: TrainingFactSuggestionStatus.REJECTED,
            reviewedById: actor.id,
            reviewedAt: new Date(),
            reviewComment: reason,
          },
        });
        await this.writeAudit(tx, {
          action: 'training.fact-suggestion.reject',
          actor,
          request,
          entityType: 'training_fact_suggestion',
          entityId: suggestion.id,
          metadata: {
            projectVersionId: versionId,
            suggestionRunId: suggestion.suggestionRunId,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
    return this.getSuggestion(versionId, suggestionId);
  }

  private async createRunInternal(
    versionIdInput: string,
    body: InternalCreateRunInput,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
    idempotencyKeyInput: unknown,
    retryOfRunId: string | null,
  ) {
    const versionId = this.parseUuid(
      versionIdInput,
      'Training version is invalid',
    );
    const idempotencyKey = this.parseIdempotencyKey(idempotencyKeyInput);
    const documentIds = this.parseUuidArray(
      body.sourceDocumentIds,
      MAX_SOURCES_PER_RUN,
      'Source document IDs',
    );
    const officialUrlIds = this.parseUuidArray(
      body.sourceOfficialUrlIds,
      MAX_SOURCES_PER_RUN,
      'Official URL source IDs',
    );
    if (
      documentIds.length + officialUrlIds.length === 0 ||
      documentIds.length + officialUrlIds.length > MAX_SOURCES_PER_RUN
    ) {
      throw new BadRequestException(
        `Select from 1 to ${MAX_SOURCES_PER_RUN} sources`,
      );
    }
    const requestPayloadHash = canonicalHash({
      versionId,
      documentIds: [...documentIds].sort(),
      officialUrlIds: [...officialUrlIds].sort(),
      retryOfRunId,
      promptVersion: TRAINING_FACT_SUGGESTION_PROMPT_VERSION,
      schemaVersion: TRAINING_FACT_SUGGESTION_SCHEMA_VERSION,
    });
    const existing = await this.prisma.trainingFactSuggestionRun.findUnique({
      where: {
        projectVersionId_createdById_idempotencyKey: {
          projectVersionId: versionId,
          createdById: actor.id,
          idempotencyKey,
        },
      },
      select: {
        id: true,
        requestPayloadHash: true,
      },
    });
    if (existing) {
      if (existing.requestPayloadHash !== requestPayloadHash) {
        throw new ConflictException(
          'Idempotency key was already used with another request',
        );
      }
      return this.getRun(versionId, existing.id);
    }

    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
      select: { status: true },
    });
    this.assertDraftVersion(version?.status);
    await this.assertNoPendingSuggestions(this.prisma, versionId);
    const preparedSources = await this.prepareSources(
      versionId,
      documentIds,
      officialUrlIds,
    );
    const existingFacts = await this.prisma.trainingFact.findMany({
      where: { projectVersionId: versionId },
      select: {
        id: true,
        code: true,
        statement: true,
        acceptedAliasesJson: true,
      },
    });
    const existingFactInputs: TrainingExistingFactInput[] = existingFacts
      .map((fact) => ({
        id: fact.id,
        code: fact.code,
        statement: fact.statement,
        acceptedAliases: parseStringArrayJson(fact.acceptedAliasesJson),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const existingFactsHash = canonicalHash(existingFactInputs);
    const sourceSnapshots: SourceSnapshot[] = preparedSources.map((source) => ({
      kind: source.kind,
      id: source.id,
      checksum: source.checksum,
      contentHash: source.contentHash,
      chunkCount: source.chunks.length,
    }));
    const runId = randomUUID();
    const providerPlans = preparedSources.flatMap((source) =>
      source.chunks.map((chunk) => ({ source, chunk })),
    );
    if (providerPlans.length === 0) {
      throw new ConflictException(
        'Selected sources contain no text for fact suggestions',
      );
    }
    assertTrainingFactSuggestionRunBudget(
      providerPlans.map(
        ({ chunk }): TrainingFactSuggestionProviderInput => ({
          runId,
          chunkId: chunk.id,
          segments: chunk.segments,
          existingFacts: existingFactInputs,
        }),
      ),
    );
    const requestedModelId =
      this.openAiConfig.providerMode === 'real'
        ? this.openAiConfig.reviewModel
        : 'fake-fact-suggestion-v1';
    const reasoningEffort =
      this.openAiConfig.providerMode === 'real'
        ? this.openAiConfig.reviewReasoning
        : null;
    const providerRows = providerPlans.map(({ source, chunk }) => ({
      id: randomUUID(),
      projectVersionId: versionId,
      suggestionRunId: runId,
      sourceDocumentId: source.kind === 'DOCUMENT' ? source.id : null,
      sourceOfficialUrlId: source.kind === 'OFFICIAL_URL' ? source.id : null,
      chunkIndex: chunk.index,
      status: TrainingProviderRunStatus.PENDING,
      idempotencyKey: `fact-suggestion-provider:${runId}:${source.kind}:${source.id}:${chunk.index}`,
      requestedModelId,
      reasoningEffort,
      sourceContentHash: source.contentHash,
      inputHash: canonicalHash({
        chunkInputHash: chunk.inputHash,
        existingFactsHash,
      }),
      inputMetadataJson: {
        chunkId: chunk.id,
        chunkInputHash: chunk.inputHash,
        existingFactsHash,
        segmentCount: chunk.segments.length,
        sourceKind: source.kind,
      },
      promptVersion: TRAINING_FACT_SUGGESTION_PROMPT_VERSION,
      schemaVersion: TRAINING_FACT_SUGGESTION_SCHEMA_VERSION,
    }));

    try {
      await this.prisma.$transaction(async (tx) => {
        const lockedVersion = await lockTrainingVersionForContentMutation(
          tx,
          versionId,
        );
        this.assertDraftVersion(lockedVersion?.status);
        if (lockedVersion?.projectStatus === 'ARCHIVED') {
          throw new ConflictException('Archived training project is immutable');
        }
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'training-fact-suggestion:' + versionId}, 0))) AS "lock_state"`,
        );
        await this.assertNoPendingSuggestions(tx, versionId);
        await this.assertPreparedSourcesCurrent(
          tx,
          versionId,
          preparedSources,
          existingFactsHash,
        );
        await tx.trainingFactSuggestionRun.create({
          data: {
            id: runId,
            projectVersionId: versionId,
            createdById: actor.id,
            status: TrainingFactSuggestionRunStatus.PENDING,
            idempotencyKey,
            requestPayloadHash,
            sourceSnapshotJson: sourceSnapshots,
            promptVersion: TRAINING_FACT_SUGGESTION_PROMPT_VERSION,
            schemaVersion: TRAINING_FACT_SUGGESTION_SCHEMA_VERSION,
          },
        });
        await tx.trainingFactSuggestionProviderRun.createMany({
          data: providerRows,
        });
        await tx.trainingJob.createMany({
          data: providerRows.map((providerRun) => ({
            kind: TrainingJobKind.SUGGEST_FACTS,
            status: TrainingJobStatus.PENDING,
            payloadJson: {
              suggestionRunId: runId,
              providerRunId: providerRun.id,
            },
            idempotencyKey: `fact-suggest:${runId}:${providerRun.id}`,
            maxAttempts: 3,
          })),
        });
        await this.writeAudit(tx, {
          action: retryOfRunId
            ? 'training.fact-suggestion-run.retry'
            : 'training.fact-suggestion-run.create',
          actor,
          request,
          entityType: 'training_fact_suggestion_run',
          entityId: runId,
          metadata: {
            projectVersionId: versionId,
            sourceDocumentIds: documentIds,
            sourceOfficialUrlIds: officialUrlIds,
            sourceContentHashes: sourceSnapshots.map((source) => ({
              kind: source.kind,
              id: source.id,
              contentHash: source.contentHash,
            })),
            providerRunCount: providerRows.length,
            existingFactCount: existingFacts.length,
            retryOfRunId,
          },
        });
      });
    } catch (error) {
      if (!isPrismaUniqueError(error)) throw error;
      const replay = await this.prisma.trainingFactSuggestionRun.findUnique({
        where: {
          projectVersionId_createdById_idempotencyKey: {
            projectVersionId: versionId,
            createdById: actor.id,
            idempotencyKey,
          },
        },
        select: {
          id: true,
          requestPayloadHash: true,
        },
      });
      if (!replay || replay.requestPayloadHash !== requestPayloadHash) {
        throw new ConflictException(
          'Fact suggestion run conflicted with another request',
        );
      }
      return this.getRun(versionId, replay.id);
    }

    return this.getRun(versionId, runId);
  }

  private async prepareSources(
    versionId: string,
    documentIds: string[],
    officialUrlIds: string[],
  ): Promise<PreparedSource[]> {
    const [documents, officialUrls] = await Promise.all([
      documentIds.length === 0
        ? []
        : this.prisma.trainingSourceDocument.findMany({
            where: {
              id: { in: documentIds },
              projectVersionId: versionId,
            },
            select: {
              id: true,
              checksum: true,
              extractionStatus: true,
              extractedText: true,
              extractionMetadataJson: true,
            },
          }),
      officialUrlIds.length === 0
        ? []
        : this.prisma.trainingOfficialUrlSource.findMany({
            where: {
              id: { in: officialUrlIds },
              projectVersionId: versionId,
            },
            select: {
              id: true,
              contentHash: true,
              extractionStatus: true,
              extractedText: true,
              extractionMetadataJson: true,
            },
          }),
    ]);
    if (
      documents.length !== documentIds.length ||
      officialUrls.length !== officialUrlIds.length
    ) {
      throw new BadRequestException(
        'Every selected source must belong to the training version',
      );
    }

    const sources: Array<
      Omit<PreparedSource, 'chunks' | 'contentHash'> & {
        extractedText: string;
        extractionStatus: TrainingSourceExtractionStatus;
      }
    > = [
      ...documents.map((document) => ({
        kind: 'DOCUMENT' as const,
        id: document.id,
        checksum: document.checksum,
        extractedText: document.extractedText ?? '',
        extractionMetadata: document.extractionMetadataJson,
        extractionStatus: document.extractionStatus,
      })),
      ...officialUrls.map((source) => ({
        kind: 'OFFICIAL_URL' as const,
        id: source.id,
        checksum: source.contentHash ?? '',
        extractedText: source.extractedText ?? '',
        extractionMetadata: source.extractionMetadataJson,
        extractionStatus: source.extractionStatus,
      })),
    ];

    return sources.map((source) => {
      if (
        source.extractionStatus !== TrainingSourceExtractionStatus.READY ||
        !source.extractedText.trim()
      ) {
        throw new ConflictException(
          'Every selected source must have ready extracted text',
        );
      }
      const chunked = buildTrainingFactSuggestionChunks([
        {
          id: source.id,
          checksum: source.checksum,
          extractedText: source.extractedText,
          extractionMetadata: source.extractionMetadata,
        } satisfies TrainingFactSuggestionSourceInput,
      ]);
      return {
        kind: source.kind,
        id: source.id,
        checksum: source.checksum,
        extractedText: source.extractedText,
        extractionMetadata: source.extractionMetadata,
        chunks: chunked.chunks,
        contentHash: chunked.sourceSnapshots[0]!.textHash,
      };
    });
  }

  private async assertNoPendingSuggestions(
    client: Pick<
      Prisma.TransactionClient,
      | 'trainingFactSuggestion'
      | 'trainingFactSuggestionRun'
      | 'trainingFactSuggestionProviderRun'
      | '$queryRaw'
    >,
    versionId: string,
  ) {
    const [pending, activeRuns, activeProviders, activeJobRows] =
      await Promise.all([
        client.trainingFactSuggestion.count({
          where: {
            projectVersionId: versionId,
            status: TrainingFactSuggestionStatus.PENDING,
          },
        }),
        client.trainingFactSuggestionRun.count({
          where: {
            projectVersionId: versionId,
            status: {
              in: [
                TrainingFactSuggestionRunStatus.PENDING,
                TrainingFactSuggestionRunStatus.RUNNING,
              ],
            },
          },
        }),
        client.trainingFactSuggestionProviderRun.count({
          where: {
            projectVersionId: versionId,
            status: {
              in: [
                TrainingProviderRunStatus.PENDING,
                TrainingProviderRunStatus.REQUESTING,
              ],
            },
          },
        }),
        client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(DISTINCT jobs."id") AS "count"
          FROM "training_jobs" AS jobs
          INNER JOIN "training_fact_suggestion_provider_runs" AS providers
            ON providers."id"::text = jobs."payload_json" ->> 'providerRunId'
          WHERE providers."project_version_id" = ${versionId}::uuid
            AND jobs."kind" = 'suggest_facts'
            AND jobs."status" IN ('pending', 'running')
        `),
      ]);
    const activeJobs = Number(activeJobRows[0]?.count ?? 0);
    if (
      pending > 0 ||
      activeRuns > 0 ||
      activeProviders > 0 ||
      activeJobs > 0
    ) {
      throw new ConflictException(
        pending > 0
          ? `Сначала обработайте все предложенные факты (${pending}), затем запустите новый анализ.`
          : 'Дождитесь завершения текущего анализа материалов',
      );
    }
  }

  private async assertPreparedSourcesCurrent(
    tx: Prisma.TransactionClient,
    versionId: string,
    sources: PreparedSource[],
    expectedFactsHash: string,
  ) {
    for (const source of sources) {
      if (source.kind === 'DOCUMENT') {
        await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${source.id}::uuid FOR SHARE`;
        const current = await tx.trainingSourceDocument.findUnique({
          where: { id: source.id },
          select: {
            projectVersionId: true,
            checksum: true,
            extractionStatus: true,
            extractedText: true,
          },
        });
        if (
          !current ||
          current.projectVersionId !== versionId ||
          current.checksum !== source.checksum ||
          current.extractionStatus !== TrainingSourceExtractionStatus.READY ||
          !current.extractedText ||
          hashTrainingFactSuggestionText(current.extractedText) !==
            source.contentHash
        ) {
          throw new ConflictException(
            'Selected source changed; refresh materials and start analysis again',
          );
        }
      } else {
        await tx.$queryRaw`SELECT "id" FROM "training_official_url_sources" WHERE "id" = ${source.id}::uuid FOR SHARE`;
        const current = await tx.trainingOfficialUrlSource.findUnique({
          where: { id: source.id },
          select: {
            projectVersionId: true,
            contentHash: true,
            extractionStatus: true,
            extractedText: true,
          },
        });
        if (
          !current ||
          current.projectVersionId !== versionId ||
          (current.contentHash ?? '') !== source.checksum ||
          current.extractionStatus !== TrainingSourceExtractionStatus.READY ||
          !current.extractedText ||
          hashTrainingFactSuggestionText(current.extractedText) !==
            source.contentHash
        ) {
          throw new ConflictException(
            'Selected source changed; refresh materials and start analysis again',
          );
        }
      }
    }
    await tx.$queryRaw`SELECT "id" FROM "training_facts" WHERE "project_version_id" = ${versionId}::uuid ORDER BY "id" FOR SHARE`;
    const facts = await tx.trainingFact.findMany({
      where: { projectVersionId: versionId },
      select: {
        id: true,
        code: true,
        statement: true,
        acceptedAliasesJson: true,
      },
      orderBy: { id: 'asc' },
    });
    const currentFactsHash = canonicalHash(
      facts.map((fact) => ({
        id: fact.id,
        code: fact.code,
        statement: fact.statement,
        acceptedAliases: parseStringArrayJson(fact.acceptedAliasesJson),
      })),
    );
    if (currentFactsHash !== expectedFactsHash) {
      throw new ConflictException(
        'Facts changed; start material analysis again',
      );
    }
  }

  private async getSuggestion(versionId: string, suggestionId: string) {
    const suggestion = await this.prisma.trainingFactSuggestion.findFirst({
      where: {
        id: suggestionId,
        projectVersionId: versionId,
      },
      include: {
        providerRun: {
          select: {
            sourceDocumentId: true,
            sourceOfficialUrlId: true,
          },
        },
      },
    });
    if (!suggestion) {
      throw new NotFoundException('Fact suggestion not found');
    }
    return { suggestion: serializeSuggestion(suggestion) };
  }

  private parseAcceptInput(body: AcceptSuggestionInput) {
    const questionIds = this.parseUuidArray(
      body.questionIds,
      11,
      'Question IDs',
    );
    if (questionIds.length === 0) {
      throw new BadRequestException(
        'Свяжите предложенный факт минимум с одним вопросом',
      );
    }
    return {
      code: this.parseCode(body.code, 'Fact code'),
      topicCode: this.parseCode(body.topicCode, 'Fact topic code'),
      statement: this.parseRequiredString(
        body.statement,
        'Fact statement is required',
        8_000,
      ),
      acceptedAliases: this.parseStringArray(
        body.acceptedAliases,
        100,
        500,
        'Accepted aliases',
      ),
      importance: this.parsePositiveInteger(
        body.importance,
        'Fact importance',
      ),
      questionIds,
      comment:
        body.comment === undefined || body.comment === null
          ? null
          : this.parseRequiredString(
              body.comment,
              'Review comment is invalid',
              2_000,
            ),
    };
  }

  private async ensureQuestionsBelongToVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    questionIds: string[],
  ) {
    if (questionIds.length === 0) return;
    const count = await tx.trainingQuestion.count({
      where: {
        id: { in: questionIds },
        projectVersionId: versionId,
      },
    });
    if (count !== questionIds.length) {
      throw new BadRequestException(
        'Every linked question must belong to the fact version',
      );
    }
  }

  private async requireVersion(id: string) {
    const versionId = this.parseUuid(id, 'Training version is invalid');
    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
      select: { id: true },
    });
    if (!version) {
      throw new NotFoundException('Training version not found');
    }
    return versionId;
  }

  private assertDraftVersion(status: TrainingVersionStatus | undefined) {
    if (status === undefined) {
      throw new NotFoundException('Training version not found');
    }
    if (status !== TrainingVersionStatus.DRAFT) {
      throw new ConflictException(
        'Published training version is immutable; open a working version',
      );
    }
  }

  private parseSourceIds(value: unknown) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_SOURCES_PER_RUN
    ) {
      throw new BadRequestException(
        `sourceIds must contain from 1 to ${MAX_SOURCES_PER_RUN} sources`,
      );
    }
    const seen = new Set<string>();
    return value.map((item) => {
      if (!isRecord(item)) {
        throw new BadRequestException('sourceIds contains an invalid source');
      }
      const unsupported = Object.keys(item).filter(
        (field) => field !== 'kind' && field !== 'id',
      );
      if (
        unsupported.length > 0 ||
        (item.kind !== 'DOCUMENT' && item.kind !== 'OFFICIAL_URL') ||
        !isTrainingUuid(item.id)
      ) {
        throw new BadRequestException('sourceIds contains an invalid source');
      }
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) {
        throw new BadRequestException('sourceIds contains duplicate sources');
      }
      seen.add(key);
      return {
        kind: item.kind,
        id: item.id,
      } satisfies { kind: SourceKind; id: string };
    });
  }

  private parseIdempotencyKey(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
      throw new BadRequestException(
        'Idempotency-Key must contain from 8 to 128 safe characters',
      );
    }
    return normalized;
  }

  private parseUuid(value: string, message: string) {
    if (!isTrainingUuid(value)) {
      throw new BadRequestException(message);
    }
    return value;
  }

  private parseUuidArray(
    value: unknown,
    maximum: number,
    label: string,
  ) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maximum) {
      throw new BadRequestException(`${label} must be an array`);
    }
    const unique = new Set<string>();
    value.forEach((item) => {
      if (!isTrainingUuid(item)) {
        throw new BadRequestException(`${label} contains an invalid ID`);
      }
      unique.add(item);
    });
    if (unique.size !== value.length) {
      throw new BadRequestException(`${label} contains duplicate IDs`);
    }
    return [...unique];
  }

  private parseCode(value: unknown, label: string) {
    const normalized = this.parseRequiredString(
      value,
      `${label} is required`,
      120,
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)) {
      throw new BadRequestException(`${label} is invalid`);
    }
    return normalized;
  }

  private parseRequiredString(
    value: unknown,
    message: string,
    maximum: number,
    minimum = 1,
  ) {
    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }
    const normalized = value.trim();
    if (normalized.length < minimum || normalized.length > maximum) {
      throw new BadRequestException(message);
    }
    return normalized;
  }

  private parseStringArray(
    value: unknown,
    maximumItems: number,
    maximumCharacters: number,
    label: string,
  ) {
    if (!Array.isArray(value) || value.length > maximumItems) {
      throw new BadRequestException(`${label} must be an array`);
    }
    const unique = new Map<string, string>();
    value.forEach((item) => {
      const text = this.parseRequiredString(
        item,
        `${label} contains an invalid item`,
        maximumCharacters,
      );
      unique.set(text.toLocaleLowerCase('ru-RU'), text);
    });
    return [...unique.values()];
  }

  private parsePositiveInteger(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${label} must be a positive integer`);
    }
    return value;
  }

  private assertOnlyFields(
    body: Record<string, unknown>,
    allowedFields: string[],
  ) {
    const unsupported = Object.keys(body).filter(
      (field) => !allowedFields.includes(field),
    );
    if (unsupported.length > 0) {
      throw new BadRequestException(
        `Unsupported fields: ${unsupported.join(', ')}`,
      );
    }
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    input: {
      action: string;
      actor: AuthenticatedUser;
      request: TrainingAuditRequest;
      entityType: string;
      entityId: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    await tx.auditLog.create({
      data: {
        action: input.action,
        actorUserId: input.actor.id,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata,
        ipAddress:
          input.request.ip ?? input.request.socket?.remoteAddress ?? null,
        userAgent: Array.isArray(input.request.headers?.['user-agent'])
          ? input.request.headers['user-agent'].join(', ')
          : (input.request.headers?.['user-agent'] ?? null),
      },
    });
  }
}

export function assertTrainingFactSuggestionRunBudget(
  providerInputs: TrainingFactSuggestionProviderInput[],
) {
  if (
    providerInputs.length >
    TRAINING_FACT_SUGGESTION_MAX_PROVIDER_RUNS_PER_RUN
  ) {
    throw factSuggestionBudgetError(
      'FACT_SUGGESTION_PROVIDER_RUN_LIMIT_EXCEEDED',
      `Выбранные материалы требуют ${providerInputs.length} запросов к провайдеру; максимум за один анализ — ${TRAINING_FACT_SUGGESTION_MAX_PROVIDER_RUNS_PER_RUN}. Уменьшите набор или объём источников.`,
    );
  }

  const potentialSuggestions =
    providerInputs.length * TRAINING_FACT_SUGGESTION_MAX_SUGGESTIONS;
  if (
    potentialSuggestions >
    TRAINING_FACT_SUGGESTION_MAX_AGGREGATE_SUGGESTIONS
  ) {
    throw factSuggestionBudgetError(
      'FACT_SUGGESTION_AGGREGATE_OUTPUT_LIMIT_EXCEEDED',
      `Выбранные материалы могут сформировать до ${potentialSuggestions} предложений; максимум за один анализ — ${TRAINING_FACT_SUGGESTION_MAX_AGGREGATE_SUGGESTIONS}.`,
    );
  }

  let aggregateInputCharacters = 0;
  for (const input of providerInputs) {
    try {
      aggregateInputCharacters +=
        serializeTrainingFactSuggestionProviderInput(input).length;
    } catch (error) {
      if (error instanceof TrainingOpenAiRequestError) {
        throw factSuggestionBudgetError(
          'FACT_SUGGESTION_PROVIDER_INPUT_LIMIT_EXCEEDED',
          'Существующие факты и выбранный фрагмент превышают безопасный размер одного запроса. Сократите материалы или объём фактов.',
          error.code,
        );
      }
      throw error;
    }
    if (
      aggregateInputCharacters >
      TRAINING_FACT_SUGGESTION_MAX_AGGREGATE_INPUT_CHARACTERS
    ) {
      throw factSuggestionBudgetError(
        'FACT_SUGGESTION_AGGREGATE_INPUT_LIMIT_EXCEEDED',
        `Суммарный объём анализа превышает безопасный лимит ${TRAINING_FACT_SUGGESTION_MAX_AGGREGATE_INPUT_CHARACTERS} символов. Уменьшите набор материалов.`,
      );
    }
  }
}

function factSuggestionBudgetError(
  code: string,
  message: string,
  providerErrorCode?: string,
) {
  return new BadRequestException({
    code,
    message,
    ...(providerErrorCode ? { providerErrorCode } : {}),
  });
}

function requireInputJson(value: Prisma.JsonValue, message: string) {
  if (value === null) {
    throw new ConflictException(message);
  }
  return value as Prisma.InputJsonValue;
}

function parseStringArrayJson(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function serializeRun(run: {
  id: string;
  status: TrainingFactSuggestionRunStatus;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  suggestions: Array<{ status: TrainingFactSuggestionStatus }>;
}) {
  const count = (status: TrainingFactSuggestionStatus) =>
    run.suggestions.filter((suggestion) => suggestion.status === status).length;
  return {
    id: run.id,
    status: run.status,
    counts: {
      total: run.suggestions.length,
      pending: count(TrainingFactSuggestionStatus.PENDING),
      accepted: count(TrainingFactSuggestionStatus.ACCEPTED),
      rejected: count(TrainingFactSuggestionStatus.REJECTED),
      stale: count(TrainingFactSuggestionStatus.STALE),
    },
    errorMessage: run.errorMessage,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function serializeSuggestion(suggestion: {
  id: string;
  suggestionRunId: string;
  status: TrainingFactSuggestionStatus;
  suggestedCode: string;
  topicCode: string;
  statement: string;
  acceptedAliasesJson: Prisma.JsonValue;
  importance: number;
  sourceLocatorJson: Prisma.JsonValue;
  sourceQuote: string;
  acceptedFactId: string | null;
  reviewComment: string | null;
  providerRun: {
    sourceDocumentId: string | null;
    sourceOfficialUrlId: string | null;
  };
}) {
  const sourceDocumentId = suggestion.providerRun.sourceDocumentId;
  const sourceOfficialUrlId = suggestion.providerRun.sourceOfficialUrlId;
  if (!sourceDocumentId && !sourceOfficialUrlId) {
    throw new ConflictException('Fact suggestion source is missing');
  }
  return {
    id: suggestion.id,
    runId: suggestion.suggestionRunId,
    status: suggestion.status,
    suggestedCode: suggestion.suggestedCode,
    topicCode: suggestion.topicCode,
    statement: suggestion.statement,
    acceptedAliases: parseStringArrayJson(suggestion.acceptedAliasesJson),
    importance: suggestion.importance,
    sourceKind: sourceDocumentId ? ('DOCUMENT' as const) : ('OFFICIAL_URL' as const),
    sourceId: sourceDocumentId ?? sourceOfficialUrlId!,
    sourceLocator: suggestion.sourceLocatorJson,
    sourceQuote: suggestion.sourceQuote,
    acceptedFactId: suggestion.acceptedFactId,
    decisionReason: suggestion.reviewComment,
  };
}

function isPrismaUniqueError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

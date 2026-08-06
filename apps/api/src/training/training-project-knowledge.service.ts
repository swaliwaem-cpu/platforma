import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  prepareTrainingQuestionKnowledge,
  TRAINING_MATERIAL_SUGGESTER,
  TRAINING_QUESTION_COMPILER_VERSION,
  TRAINING_QUESTION_PROMPT_VERSION,
  type TrainingGeneratedQuestionDraft,
  type TrainingMaterialSuggester,
  type TrainingQuestionDraftGenerationInput,
  type TrainingQuestionDraftGenerationResult,
  validateQuestionDraftGeneration,
} from './training-material-suggester';
import {
  readTrainingOpenAIInteger,
  TrainingOpenAIError,
} from './training-openai-client';

const KNOWLEDGE_SCHEMA_VERSION = 1;
const DEFAULT_GENERATION_LEASE_MS = 180_000;
const KNOWLEDGE_POLL_INTERVAL_MS = 100;

export type TrainingCompiledProjectKnowledge = {
  generated: TrainingQuestionDraftGenerationResult;
  sourceHash: string;
  compilationVersion: number;
  baseProjectKnowledgeVersion: number;
  reused: boolean;
  references: ReturnType<typeof prepareTrainingQuestionKnowledge>['references'];
};

@Injectable()
export class TrainingProjectKnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRAINING_MATERIAL_SUGGESTER)
    private readonly suggester: TrainingMaterialSuggester,
  ) {}

  async compile(
    input: TrainingQuestionDraftGenerationInput,
  ): Promise<TrainingCompiledProjectKnowledge> {
    const prepared = prepareTrainingQuestionKnowledge(input);
    const token = randomUUID();
    const claim = await this.claim(
      input.projectId,
      input.expectedProjectKnowledgeVersion,
      prepared,
      token,
    );

    if (claim.kind === 'READY') {
      return this.fromReadyRow(
        claim.row,
        prepared,
        true,
        claim.projectKnowledgeVersion,
      );
    }
    if (claim.kind === 'WAIT') {
      const ready = await this.waitForReady(claim.row.id);
      return this.fromReadyRow(
        ready,
        prepared,
        true,
        claim.projectKnowledgeVersion,
      );
    }

    try {
      const generated = await this.suggester.generateQuestionDrafts(input);
      validateQuestionDraftGeneration(generated, prepared.segments);
      const criteria = await this.prisma.trainingCriterion.findMany({
        where: { projectId: input.projectId, isActive: true },
        select: {
          id: true,
          questionType: true,
          code: true,
          title: true,
          guidance: true,
          maxPoints: true,
          position: true,
        },
        orderBy: [{ questionType: 'asc' }, { position: 'asc' }, { id: 'asc' }],
      });
      const knowledgeJson = {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        compilerVersion: TRAINING_QUESTION_COMPILER_VERSION,
        promptVersion: TRAINING_QUESTION_PROMPT_VERSION,
        main: generated.main,
        followUps: generated.followUps,
        criteria,
        relations: [generated.main, ...generated.followUps].flatMap((question, questionIndex) =>
          question.facts.map((fact, factIndex) => ({
            questionIndex,
            factIndex,
            sourceLocator: fact.sourceLocator,
          })),
        ),
      };
      const saved = await this.prisma.trainingProjectKnowledgeVersion.updateMany({
        where: {
          id: claim.row.id,
          status: 'GENERATING',
          generationToken: token,
        },
        data: {
          status: 'READY',
          compiledKnowledgeJson: knowledgeJson as unknown as Prisma.InputJsonValue,
          sourceChars: generated.sourceChars,
          generationModel: generated.model,
          generationRequestIdsJson: {
            ids: generated.requestIds,
            responseId: generated.responseId,
          } as Prisma.InputJsonValue,
          generationAttempts: { increment: generated.attempts },
          generationToken: null,
          lockedAt: null,
          errorCode: null,
        },
      });
      if (saved.count !== 1) {
        throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_CLAIM_LOST', true);
      }

      return {
        generated,
        sourceHash: prepared.sourceHash,
        compilationVersion: claim.row.version,
        baseProjectKnowledgeVersion: claim.projectKnowledgeVersion,
        reused: false,
        references: prepared.references,
      };
    } catch (error) {
      await this.failClaim(claim.row.id, token, error);
      throw error;
    }
  }

  private async claim(
    projectId: string,
    expectedProjectKnowledgeVersion: number | undefined,
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>,
    token: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const projectRows = await transaction.$queryRaw<Array<{ knowledge_version: number }>>(
        Prisma.sql`
          SELECT "knowledge_version"
          FROM "training_projects"
          WHERE "id" = CAST(${projectId} AS uuid)
          FOR UPDATE
        `,
      );
      const project = projectRows[0];
      if (!project) throw new TrainingOpenAIError('TRAINING_PROJECT_NOT_FOUND', false);
      if (
        expectedProjectKnowledgeVersion !== undefined &&
        project.knowledge_version !== expectedProjectKnowledgeVersion
      ) {
        throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_SOURCE_STALE', true);
      }
      const existing = await transaction.trainingProjectKnowledgeVersion.findUnique({
        where: {
          projectId_sourceHash: { projectId, sourceHash: prepared.sourceHash },
        },
      });

      if (existing?.status === 'READY' && existing.compiledKnowledgeJson !== null) {
        return {
          kind: 'READY' as const,
          row: existing,
          projectKnowledgeVersion: project.knowledge_version,
        };
      }
      const staleBefore = new Date(Date.now() - readGenerationLeaseMs());
      if (
        existing?.status === 'GENERATING' &&
        existing.lockedAt &&
        existing.lockedAt > staleBefore
      ) {
        return {
          kind: 'WAIT' as const,
          row: existing,
          projectKnowledgeVersion: project.knowledge_version,
        };
      }

      if (existing) {
        const row = await transaction.trainingProjectKnowledgeVersion.update({
          where: { id: existing.id },
          data: {
            status: 'GENERATING',
            sourceManifestJson: prepared.sourceManifest as unknown as Prisma.InputJsonValue,
            compiledKnowledgeJson: Prisma.DbNull,
            generationToken: token,
            lockedAt: new Date(),
            errorCode: null,
          },
        });
        return {
          kind: 'CLAIMED' as const,
          row,
          projectKnowledgeVersion: project.knowledge_version,
        };
      }

      const aggregate = await transaction.trainingProjectKnowledgeVersion.aggregate({
        where: { projectId },
        _max: { version: true },
      });
      const version = Math.max(
        aggregate._max.version ?? 0,
        project.knowledge_version,
      ) + 1;
      const row = await transaction.trainingProjectKnowledgeVersion.create({
        data: {
          projectId,
          version,
          sourceHash: prepared.sourceHash,
          compilerVersion: TRAINING_QUESTION_COMPILER_VERSION,
          promptVersion: TRAINING_QUESTION_PROMPT_VERSION,
          status: 'GENERATING',
          sourceManifestJson: prepared.sourceManifest as unknown as Prisma.InputJsonValue,
          generationToken: token,
          lockedAt: new Date(),
        },
      });
      return {
        kind: 'CLAIMED' as const,
        row,
        projectKnowledgeVersion: project.knowledge_version,
      };
    });
  }

  private async waitForReady(id: string) {
    const deadline = Date.now() + readGenerationLeaseMs() + 5_000;

    while (Date.now() < deadline) {
      const row = await this.prisma.trainingProjectKnowledgeVersion.findUnique({
        where: { id },
      });
      if (!row) throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_MISSING', true);
      if (row.status === 'READY' && row.compiledKnowledgeJson !== null) return row;
      if (row.status === 'FAILED') {
        throw new TrainingOpenAIError(row.errorCode ?? 'QUESTION_KNOWLEDGE_FAILED', true);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, KNOWLEDGE_POLL_INTERVAL_MS));
    }

    throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_WAIT_TIMEOUT', true);
  }

  private fromReadyRow(
    row: {
      version: number;
      sourceHash: string;
      compiledKnowledgeJson: Prisma.JsonValue | null;
      generationModel: string | null;
      generationRequestIdsJson: Prisma.JsonValue | null;
      generationAttempts: number;
      sourceChars: number | null;
      updatedAt: Date;
    },
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>,
    reused: boolean,
    baseProjectKnowledgeVersion: number,
  ): TrainingCompiledProjectKnowledge {
    const parsed = parseCompiledKnowledge(row.compiledKnowledgeJson);
    const generated: TrainingQuestionDraftGenerationResult = {
      main: parsed.main,
      followUps: parsed.followUps,
      model: row.generationModel ?? 'unknown',
      requestIds: readRequestIds(row.generationRequestIdsJson),
      attempts: row.generationAttempts,
      sourceChars: row.sourceChars ?? prepared.segments.reduce(
        (total, segment) => total + segment.text.length,
        0,
      ),
      generatedAt: row.updatedAt,
      responseId: readResponseId(row.generationRequestIdsJson),
      usage: null,
    };
    validateQuestionDraftGeneration(generated, prepared.segments);
    return {
      generated,
      sourceHash: row.sourceHash,
      compilationVersion: row.version,
      baseProjectKnowledgeVersion,
      reused,
      references: prepared.references,
    };
  }

  private async failClaim(id: string, token: string, error: unknown) {
    const code = error instanceof TrainingOpenAIError
      ? error.code
      : 'QUESTION_KNOWLEDGE_GENERATION_FAILED';
    await this.prisma.trainingProjectKnowledgeVersion.updateMany({
      where: { id, status: 'GENERATING', generationToken: token },
      data: {
        status: 'FAILED',
        generationAttempts: {
          increment: error instanceof TrainingOpenAIError ? error.attempts : 0,
        },
        generationToken: null,
        lockedAt: null,
        errorCode: code.slice(0, 120),
      },
    }).catch(() => undefined);
  }
}

function parseCompiledKnowledge(value: unknown): {
  main: TrainingGeneratedQuestionDraft;
  followUps: TrainingGeneratedQuestionDraft[];
} {
  if (!isRecord(value) || value.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
    throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_INVALID', false);
  }
  return {
    main: parseQuestion(value.main),
    followUps: Array.isArray(value.followUps) ? value.followUps.map(parseQuestion) : [],
  };
}

function parseQuestion(value: unknown): TrainingGeneratedQuestionDraft {
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.facts)) {
    throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_INVALID', false);
  }
  return {
    text: value.text,
    facts: value.facts.map((fact) => {
      if (
        !isRecord(fact) ||
        typeof fact.statement !== 'string' ||
        !Array.isArray(fact.aliases) ||
        fact.aliases.some((alias) => typeof alias !== 'string') ||
        typeof fact.isRequired !== 'boolean' ||
        typeof fact.sourceLocator !== 'string' ||
        typeof fact.sourceExcerpt !== 'string'
      ) {
        throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_INVALID', false);
      }
      return {
        statement: fact.statement,
        aliases: fact.aliases as string[],
        isRequired: fact.isRequired,
        sourceLocator: fact.sourceLocator,
        sourceExcerpt: fact.sourceExcerpt,
      };
    }),
  };
}

function readRequestIds(value: unknown) {
  return isRecord(value) && Array.isArray(value.ids)
    ? value.ids.filter((id): id is string => typeof id === 'string')
    : [];
}

function readResponseId(value: unknown) {
  return isRecord(value) && typeof value.responseId === 'string' ? value.responseId : null;
}

function readGenerationLeaseMs() {
  const configuredLease = readTrainingOpenAIInteger(
    'OPENAI_QUESTION_GENERATION_LEASE_MS',
    DEFAULT_GENERATION_LEASE_MS,
    30_000,
    600_000,
  );
  const providerTimeout = readTrainingOpenAIInteger(
    'TRAINING_MATERIAL_SUGGESTION_TIMEOUT_MS',
    120_000,
    1_000,
    300_000,
  );
  return Math.max(configuredLease, providerTimeout + 30_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

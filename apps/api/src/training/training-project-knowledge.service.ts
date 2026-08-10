import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  createTrainingQuestionQualityContext,
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
import {
  createTrainingQuestionGenerationArtifactPayload,
  createTrainingQuestionGenerationPlan,
  materializeTrainingQuestionGenerationArtifact,
  type TrainingQuestionGenerationPlan,
} from './training-question-generation-artifact';
import { isTrainingCrossProjectGenerationReuseEnabled } from './training-runtime-config';

const KNOWLEDGE_SCHEMA_VERSION = 1;
const DEFAULT_GENERATION_LEASE_MS = 180_000;
const KNOWLEDGE_POLL_INTERVAL_MS = 100;
const SHARED_ARTIFACT_CLAIM_CYCLES = 2;

type SharedArtifactRow = {
  id: string;
  status: string;
  artifactJson: Prisma.JsonValue | null;
  generationModel: string;
  generationRequestIdsJson: Prisma.JsonValue | null;
  generationAttempts: number;
  sourceChars: number | null;
  generationToken: string | null;
  lockedAt: Date | null;
  updatedAt: Date;
};

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
      input,
      prepared,
      token,
      isTrainingCrossProjectGenerationReuseEnabled(),
    );

    if (claim.kind === 'READY') {
      return this.fromReadyRow(
        claim.row,
        prepared,
        input.objectTitle,
        true,
        claim.projectKnowledgeVersion,
      );
    }
    if (claim.kind === 'WAIT') {
      const ready = await this.waitForReady(claim.row.id);
      return this.fromReadyRow(
        ready,
        prepared,
        input.objectTitle,
        true,
        claim.projectKnowledgeVersion,
      );
    }

    try {
      const shared = claim.generationPlan
        ? await this.obtainSharedArtifact(input, prepared, claim.generationPlan)
        : null;
      const generated = shared?.generated ?? await this.suggester.generateQuestionDrafts(
        input,
        { preparedSource: prepared },
      );
      validateQuestionDraftGeneration(
        generated,
        prepared.segments,
        false,
        createTrainingQuestionQualityContext(prepared, input.objectTitle),
      );
      return await this.completeProjectClaim({
        input,
        prepared,
        generated,
        claim,
        token,
        generationArtifactId: shared?.artifactId ?? null,
        reused: shared?.reused ?? false,
      });
    } catch (error) {
      await this.failClaim(claim.row.id, token, error);
      throw error;
    }
  }

  private async completeProjectClaim(input: {
    input: TrainingQuestionDraftGenerationInput;
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>;
    generated: TrainingQuestionDraftGenerationResult;
    claim: {
      row: { id: string; version: number; sourceHash: string };
      projectKnowledgeVersion: number;
    };
    token: string;
    generationArtifactId: string | null;
    reused: boolean;
  }): Promise<TrainingCompiledProjectKnowledge> {
    const criteria = await this.prisma.trainingCriterion.findMany({
      where: { projectId: input.input.projectId, isActive: true },
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
      main: input.generated.main,
      followUps: input.generated.followUps,
      criteria,
      relations: [input.generated.main, ...input.generated.followUps].flatMap(
        (question, questionIndex) => question.facts.map((fact, factIndex) => ({
          questionIndex,
          factIndex,
          sourceLocator: fact.sourceLocator,
        })),
      ),
    };
    const saved = await this.prisma.trainingProjectKnowledgeVersion.updateMany({
      where: {
        id: input.claim.row.id,
        status: 'GENERATING',
        generationToken: input.token,
      },
      data: {
        status: 'READY',
        compiledKnowledgeJson: knowledgeJson as unknown as Prisma.InputJsonValue,
        sourceChars: input.generated.sourceChars,
        generationModel: input.generated.model,
        generationRequestIdsJson: {
          ids: input.generated.requestIds,
          responseId: input.generated.responseId,
        } as Prisma.InputJsonValue,
        generationAttempts: { increment: input.generated.attempts },
        generationToken: null,
        lockedAt: null,
        errorCode: null,
        generationArtifactId: input.generationArtifactId,
      },
    });
    if (saved.count !== 1) {
      throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_CLAIM_LOST', true);
    }

    return {
      generated: input.generated,
      sourceHash: input.claim.row.sourceHash,
      compilationVersion: input.claim.row.version,
      baseProjectKnowledgeVersion: input.claim.projectKnowledgeVersion,
      reused: input.reused,
      references: input.prepared.references,
    };
  }

  private async claim(
    input: TrainingQuestionDraftGenerationInput,
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>,
    token: string,
    sharedReuseEnabled: boolean,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const projectRows = await transaction.$queryRaw<Array<{
        knowledge_version: number;
        real_estate_object_id: string | null;
      }>>(
        Prisma.sql`
          SELECT "knowledge_version", "real_estate_object_id"
          FROM "training_projects"
          WHERE "id" = CAST(${input.projectId} AS uuid)
          FOR UPDATE
        `,
      );
      const project = projectRows[0];
      if (!project) throw new TrainingOpenAIError('TRAINING_PROJECT_NOT_FOUND', false);
      if (
        input.expectedProjectKnowledgeVersion !== undefined &&
        project.knowledge_version !== input.expectedProjectKnowledgeVersion
      ) {
        throw new TrainingOpenAIError('QUESTION_KNOWLEDGE_SOURCE_STALE', true);
      }
      const generationPlan = sharedReuseEnabled
        ? createTrainingQuestionGenerationPlan(
            input,
            prepared,
            project.real_estate_object_id,
          )
        : null;
      const sourceHash = generationPlan?.generationKeyHash ?? prepared.sourceHash;
      const leaseMs = readGenerationLeaseMs();
      const existingRows = await transaction.$queryRaw<Array<{
        id: string;
        lockIsFresh: boolean;
      }>>(Prisma.sql`
        SELECT
          "id",
          (
            "locked_at" IS NOT NULL AND
            "locked_at" > CURRENT_TIMESTAMP - (${leaseMs} * INTERVAL '1 millisecond')
          ) AS "lockIsFresh"
        FROM "training_project_knowledge_versions"
        WHERE "project_id" = CAST(${input.projectId} AS uuid)
          AND "source_hash" = ${sourceHash}
        FOR UPDATE
      `);
      const existing = existingRows[0]
        ? await transaction.trainingProjectKnowledgeVersion.findUniqueOrThrow({
            where: { id: existingRows[0].id },
          })
        : null;

      if (existing?.status === 'READY' && existing.compiledKnowledgeJson !== null) {
        return {
          kind: 'READY' as const,
          row: existing,
          projectKnowledgeVersion: project.knowledge_version,
          generationPlan,
        };
      }
      const existingLockIsFresh = existing?.status === 'GENERATING' &&
        existingRows[0]?.lockIsFresh === true;
      if (
        existing?.status === 'GENERATING' &&
        existingLockIsFresh
      ) {
        return {
          kind: 'WAIT' as const,
          row: existing,
          projectKnowledgeVersion: project.knowledge_version,
          generationPlan,
        };
      }

      if (existing) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE "training_project_knowledge_versions"
          SET
            "status" = 'GENERATING',
            "source_manifest_json" = CAST(${JSON.stringify(prepared.sourceManifest)} AS jsonb),
            "compiled_knowledge_json" = NULL,
            "generation_artifact_id" = NULL,
            "generation_token" = ${token},
            "locked_at" = CURRENT_TIMESTAMP,
            "error_code" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = CAST(${existing.id} AS uuid)
        `);
        const row = await transaction.trainingProjectKnowledgeVersion.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return {
          kind: 'CLAIMED' as const,
          row,
          projectKnowledgeVersion: project.knowledge_version,
          generationPlan,
        };
      }

      const aggregate = await transaction.trainingProjectKnowledgeVersion.aggregate({
        where: { projectId: input.projectId },
        _max: { version: true },
      });
      const version = Math.max(
        aggregate._max.version ?? 0,
        project.knowledge_version,
      ) + 1;
      const created = await transaction.trainingProjectKnowledgeVersion.create({
        data: {
          projectId: input.projectId,
          version,
          sourceHash,
          compilerVersion: TRAINING_QUESTION_COMPILER_VERSION,
          promptVersion: TRAINING_QUESTION_PROMPT_VERSION,
          status: 'GENERATING',
          sourceManifestJson: prepared.sourceManifest as unknown as Prisma.InputJsonValue,
          generationToken: token,
          lockedAt: new Date(),
        },
      });
      await transaction.$executeRaw(Prisma.sql`
        UPDATE "training_project_knowledge_versions"
        SET "locked_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${created.id} AS uuid)
      `);
      const row = await transaction.trainingProjectKnowledgeVersion.findUniqueOrThrow({
        where: { id: created.id },
      });
      return {
        kind: 'CLAIMED' as const,
        row,
        projectKnowledgeVersion: project.knowledge_version,
        generationPlan,
      };
    });
  }

  private async obtainSharedArtifact(
    input: TrainingQuestionDraftGenerationInput,
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>,
    plan: TrainingQuestionGenerationPlan,
  ) {
    for (let cycle = 0; cycle < SHARED_ARTIFACT_CLAIM_CYCLES; cycle += 1) {
      const token = randomUUID();
      const claim = await this.claimSharedArtifact(plan, token);

      if (claim.kind === 'READY') {
        return this.fromReadySharedArtifact(claim.row, prepared, input.objectTitle, true);
      }
      if (claim.kind === 'WAIT') {
        const ready = await this.waitForSharedArtifact(claim.row.id);
        if (ready) return this.fromReadySharedArtifact(ready, prepared, input.objectTitle, true);
        continue;
      }

      return this.generateSharedArtifact(input, prepared, claim.row, token);
    }

    throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_WAIT_TIMEOUT', true);
  }

  private async claimSharedArtifact(
    plan: TrainingQuestionGenerationPlan,
    token: string,
  ) {
    const leaseMs = readGenerationLeaseMs();
    return this.prisma.$transaction(async (transaction) => {
      const id = randomUUID();
      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO "training_question_generation_artifacts" (
          "id",
          "real_estate_object_id",
          "generation_key_hash",
          "generation_key_json",
          "source_fingerprint",
          "artifact_schema_version",
          "compiler_version",
          "prompt_version",
          "generation_model",
          "generation_reasoning",
          "routing_strategy",
          "chosen_budget",
          "budget_policy_version",
          "max_output_tokens",
          "status",
          "generation_token",
          "locked_at",
          "created_at",
          "updated_at"
        ) VALUES (
          CAST(${id} AS uuid),
          CAST(${plan.realEstateObjectId} AS uuid),
          ${plan.generationKeyHash},
          CAST(${JSON.stringify(plan.generationKey)} AS jsonb),
          ${plan.sourceFingerprint},
          ${plan.artifactSchemaVersion},
          ${plan.compilerVersion},
          ${plan.promptVersion},
          ${plan.generationModel},
          ${plan.generationReasoning},
          ${plan.routingStrategy},
          ${plan.chosenBudget},
          ${plan.budgetPolicyVersion},
          ${plan.maxOutputTokens},
          'GENERATING',
          ${token},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT ("real_estate_object_id", "generation_key_hash") DO NOTHING
      `);
      const rows = await transaction.$queryRaw<Array<SharedArtifactRow & {
        lockIsFresh: boolean;
      }>>(Prisma.sql`
        SELECT
          "id",
          "status",
          "artifact_json" AS "artifactJson",
          "generation_model" AS "generationModel",
          "generation_request_ids_json" AS "generationRequestIdsJson",
          "generation_attempts" AS "generationAttempts",
          "source_chars" AS "sourceChars",
          "generation_token" AS "generationToken",
          "locked_at" AS "lockedAt",
          "updated_at" AS "updatedAt",
          (
            "locked_at" IS NOT NULL AND
            "locked_at" > CURRENT_TIMESTAMP - (${leaseMs} * INTERVAL '1 millisecond')
          ) AS "lockIsFresh"
        FROM "training_question_generation_artifacts"
        WHERE "real_estate_object_id" = CAST(${plan.realEstateObjectId} AS uuid)
          AND "generation_key_hash" = ${plan.generationKeyHash}
        FOR UPDATE
      `);
      const existing = rows[0];
      if (!existing) {
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_MISSING', true);
      }
      if (existing.status === 'READY' && existing.artifactJson !== null) {
        return { kind: 'READY' as const, row: existing };
      }
      if (existing.status === 'GENERATING' && existing.generationToken === token) {
        return { kind: 'CLAIMED' as const, row: existing };
      }
      if (existing.status === 'GENERATING' && existing.lockIsFresh) {
        return { kind: 'WAIT' as const, row: existing };
      }

      const reclaimed = await transaction.$queryRaw<Array<SharedArtifactRow>>(Prisma.sql`
        UPDATE "training_question_generation_artifacts"
        SET
          "status" = 'GENERATING',
          "artifact_json" = NULL,
          "source_chars" = NULL,
          "generation_request_ids_json" = NULL,
          "generation_token" = ${token},
          "locked_at" = CURRENT_TIMESTAMP,
          "error_code" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${existing.id} AS uuid)
        RETURNING
          "id",
          "status",
          "artifact_json" AS "artifactJson",
          "generation_model" AS "generationModel",
          "generation_request_ids_json" AS "generationRequestIdsJson",
          "generation_attempts" AS "generationAttempts",
          "source_chars" AS "sourceChars",
          "generation_token" AS "generationToken",
          "locked_at" AS "lockedAt",
          "updated_at" AS "updatedAt"
      `);
      const row = reclaimed[0];
      if (!row) {
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_MISSING', true);
      }
      return { kind: 'CLAIMED' as const, row };
    });
  }

  private async generateSharedArtifact(
    input: TrainingQuestionDraftGenerationInput,
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>,
    row: SharedArtifactRow,
    token: string,
  ) {
    const stopHeartbeat = this.startSharedArtifactHeartbeat(row.id, token);
    try {
      const generated = await this.suggester.generateQuestionDrafts(input, {
        preparedSource: prepared,
      });
      validateQuestionDraftGeneration(
        generated,
        prepared.segments,
        false,
        createTrainingQuestionQualityContext(prepared, input.objectTitle),
      );
      const payload = createTrainingQuestionGenerationArtifactPayload(generated, prepared);
      const saved = await this.prisma.trainingQuestionGenerationArtifact.updateMany({
        where: { id: row.id, status: 'GENERATING', generationToken: token },
        data: {
          status: 'READY',
          artifactJson: payload as unknown as Prisma.InputJsonValue,
          generationModel: generated.model,
          sourceChars: generated.sourceChars,
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
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_CLAIM_LOST', true);
      }
      return { artifactId: row.id, generated, reused: false };
    } catch (error) {
      await this.failSharedArtifact(row.id, token, error);
      throw error;
    } finally {
      await stopHeartbeat();
    }
  }

  private async waitForSharedArtifact(id: string) {
    const leaseMs = readGenerationLeaseMs();
    const deadline = Date.now() + leaseMs + 5_000;

    while (Date.now() < deadline) {
      const rows = await this.prisma.$queryRaw<Array<SharedArtifactRow & {
        lockIsFresh: boolean;
      }>>(Prisma.sql`
        SELECT
          "id",
          "status",
          "artifact_json" AS "artifactJson",
          "generation_model" AS "generationModel",
          "generation_request_ids_json" AS "generationRequestIdsJson",
          "generation_attempts" AS "generationAttempts",
          "source_chars" AS "sourceChars",
          "generation_token" AS "generationToken",
          "locked_at" AS "lockedAt",
          "updated_at" AS "updatedAt",
          (
            "locked_at" IS NOT NULL AND
            "locked_at" > CURRENT_TIMESTAMP - (${leaseMs} * INTERVAL '1 millisecond')
          ) AS "lockIsFresh"
        FROM "training_question_generation_artifacts"
        WHERE "id" = CAST(${id} AS uuid)
      `);
      const row = rows[0];
      if (!row) {
        throw new TrainingOpenAIError('QUESTION_GENERATION_ARTIFACT_MISSING', true);
      }
      if (row.status === 'READY' && row.artifactJson !== null) return row;
      if (row.status === 'FAILED') return null;
      if (!row.lockIsFresh) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, KNOWLEDGE_POLL_INTERVAL_MS));
    }
    return null;
  }

  private fromReadySharedArtifact(
    row: SharedArtifactRow,
    prepared: ReturnType<typeof prepareTrainingQuestionKnowledge>,
    objectTitle: string,
    reused: boolean,
  ) {
    const drafts = materializeTrainingQuestionGenerationArtifact(row.artifactJson, prepared);
    const generated: TrainingQuestionDraftGenerationResult = {
      ...drafts,
      model: row.generationModel,
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
    validateQuestionDraftGeneration(
      generated,
      prepared.segments,
      false,
      createTrainingQuestionQualityContext(prepared, objectTitle),
    );
    return { artifactId: row.id, generated, reused };
  }

  private startSharedArtifactHeartbeat(id: string, token: string) {
    const intervalMs = Math.max(1_000, Math.floor(readGenerationLeaseMs() / 3));
    let pending = Promise.resolve();
    const timer = setInterval(() => {
      pending = pending.then(async () => {
        try {
          const count = await this.prisma.$executeRaw(Prisma.sql`
            UPDATE "training_question_generation_artifacts"
            SET "locked_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
            WHERE "id" = CAST(${id} AS uuid)
              AND "status" = 'GENERATING'
              AND "generation_token" = ${token}
          `);
          if (count !== 1) clearInterval(timer);
        } catch {
          // A transient DB error must not permanently stop lease renewal.
        }
      });
    }, intervalMs);
    timer.unref();

    return async () => {
      clearInterval(timer);
      await pending;
    };
  }

  private async failSharedArtifact(id: string, token: string, error: unknown) {
    const code = error instanceof TrainingOpenAIError
      ? error.code
      : 'QUESTION_GENERATION_ARTIFACT_FAILED';
    await this.prisma.trainingQuestionGenerationArtifact.updateMany({
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
    objectTitle: string,
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
    validateQuestionDraftGeneration(
      generated,
      prepared.segments,
      false,
      createTrainingQuestionQualityContext(prepared, objectTitle),
    );
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

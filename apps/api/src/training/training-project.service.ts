import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingProjectAccessMode,
  TrainingProjectStatus,
  TrainingQuestionType,
} from '@prisma/client';
import type {
  TrainingAdminProject,
  TrainingAdminProjectsResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TrainingProjectCleanupObject } from './training-project-cleanup';
import {
  TRAINING_FACT_ALIAS_LIMIT,
  TRAINING_FACT_ALIAS_MAX_LENGTH,
  TRAINING_SNAPSHOT_FOLLOW_UP_COUNT,
  TRAINING_STAGE3_SNAPSHOT_SCHEMA_VERSION,
  TRAINING_SNAPSHOT_SCHEMA_VERSION,
} from './training-snapshot';

export type CreateTrainingProjectInput = {
  title: string;
  description: string | null;
  realEstateObjectId: string | null;
  sortOrder: number;
  attemptLimit: number;
  timeLimitSeconds: number;
  passScore: number;
  allowRetakeAfterPass: boolean;
  accessMode: TrainingProjectAccessMode;
};

export type TrainingFactDraftInput = {
  id: string | null;
  questionType: TrainingQuestionType;
  questionPosition: number;
  statement: string;
  aliases: string[];
  isRequired: boolean;
  position: number;
};

export type TrainingCriterionDraftInput = {
  id: string | null;
  questionType: TrainingQuestionType;
  code: string;
  title: string;
  guidance: string;
  maxPoints: number;
  position: number;
};

export type UpdateTrainingProjectDraftInput = CreateTrainingProjectInput & {
  mainQuestion: string;
  followUpQuestions: string[];
  facts: TrainingFactDraftInput[];
  criteria: TrainingCriterionDraftInput[];
};

const DEFAULT_CRITERIA: readonly Omit<TrainingCriterionDraftInput, 'id'>[] = [
  {
    questionType: TrainingQuestionType.MAIN,
    code: 'completeness',
    title: 'Полнота',
    guidance: '',
    maxPoints: 5,
    position: 1,
  },
  {
    questionType: TrainingQuestionType.MAIN,
    code: 'vocabulary',
    title: 'Профессиональная лексика',
    guidance: '',
    maxPoints: 15,
    position: 2,
  },
  {
    questionType: TrainingQuestionType.MAIN,
    code: 'factual_accuracy',
    title: 'Фактическая точность',
    guidance: '',
    maxPoints: 15,
    position: 3,
  },
  {
    questionType: TrainingQuestionType.MAIN,
    code: 'structure',
    title: 'Структура',
    guidance: '',
    maxPoints: 10,
    position: 4,
  },
  {
    questionType: TrainingQuestionType.MAIN,
    code: 'delivery',
    title: 'Подача',
    guidance: '',
    maxPoints: 10,
    position: 5,
  },
  {
    questionType: TrainingQuestionType.FOLLOW_UP,
    code: 'answer_quality',
    title: 'Качество ответа',
    guidance: '',
    maxPoints: 15,
    position: 1,
  },
];

const FILE_CLEANUP_CONCURRENCY = 5;
const PROJECT_DELETE_TRANSACTION_TIMEOUT_MS = 30_000;
const PROJECT_DELETE_AUDIT_ACTION = 'training.project.delete';

type StoredObjectCleanup = TrainingProjectCleanupObject;

type ProjectDeleteAuditMetadata = {
  title: string;
  attemptsCount: number;
  assignmentsCount: number;
  materialsCount: number;
  cleanupStatus: 'PENDING' | 'COMPLETED';
  cleanupRevision: number;
  storageObjects: StoredObjectCleanup[];
  cleanupCompletedAt?: string;
};

const projectDeletionFileSelect = {
  id: true,
  key: true,
  bucket: true,
  variants: {
    select: {
      key: true,
      bucket: true,
    },
  },
  _count: {
    select: {
      profilePhotoUsers: true,
      objectImages: true,
      objectFiles: true,
      feedXmlSources: true,
      feedMediaAssets: true,
      lotPresentationDocuments: true,
      projectPresentationDraftCovers: true,
      projectPresentationDocuments: true,
      projectPresentationAssets: true,
      trainingAnswerSegments: true,
      trainingMergedAnswers: true,
      trainingMaterialRevisions: true,
    },
  },
} as const satisfies Prisma.FileSelect;

type ProjectDeletionFile = Prisma.FileGetPayload<{
  select: typeof projectDeletionFileSelect;
}>;

const adminProjectInclude = {
  questions: {
    include: {
      facts: {
        include: {
          sourceRevision: { include: { material: true } },
        },
      },
    },
  },
  criteria: true,
  _count: {
    select: {
      assignments: { where: { revokedAt: null } },
    },
  },
} as const satisfies Prisma.TrainingProjectInclude;

type AdminProjectRecord = Prisma.TrainingProjectGetPayload<{
  include: typeof adminProjectInclude;
}>;

@Injectable()
export class TrainingProjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async listAdminProjects(): Promise<TrainingAdminProjectsResponse> {
    const projects = await this.prisma.trainingProject.findMany({
      include: {
        _count: {
          select: {
            attempts: true,
            questions: true,
            assignments: { where: { revokedAt: null } },
          },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    return {
      items: projects.map((project) => ({
        id: project.id,
        title: project.title,
        status: project.status,
        accessMode: project.accessMode,
        activeAssignments: project._count.assignments,
        isOpen: project.isOpen,
        sortOrder: project.sortOrder,
        attemptLimit: project.attemptLimit,
        timeLimitSeconds: project.timeLimitSeconds,
        passScore: project.passScore,
        questionsCount: project._count.questions,
        attemptsCount: project._count.attempts,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
      })),
    };
  }

  async getAdminProject(projectId: string): Promise<TrainingAdminProject> {
    const project = await this.prisma.trainingProject.findUnique({
      where: { id: projectId },
      include: adminProjectInclude,
    });

    if (!project) {
      throw new NotFoundException('Training project not found');
    }

    return this.serializeAdminProject(project);
  }

  async createProject(input: CreateTrainingProjectInput) {
    await this.ensureRealEstateObjectExists(input.realEstateObjectId);

    const projectId = await this.prisma.$transaction(async (transaction) => {
      const project = await transaction.trainingProject.create({
        data: {
          ...input,
          contentSchemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION,
        },
        select: { id: true },
      });
      await transaction.trainingCriterion.createMany({
        data: DEFAULT_CRITERIA.map((criterion) => ({
          ...criterion,
          id: randomUUID(),
          projectId: project.id,
        })),
      });

      return project.id;
    });

    return this.getAdminProject(projectId);
  }

  async deleteProject(projectId: string, actorUserId: string) {
    const cleanup = await this.prisma.$transaction(async (transaction) => {
      await this.lockActor(transaction, actorUserId);
      await this.lockProjectDeletionGraph(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          title: true,
          _count: {
            select: {
              attempts: true,
              assignments: true,
              materials: true,
            },
          },
        },
      });

      if (!project) {
        const pendingAudit = await transaction.auditLog.findFirst({
          where: {
            action: PROJECT_DELETE_AUDIT_ACTION,
            entityType: 'training_project',
            entityId: projectId,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, metadata: true },
        });
        const metadata = parseProjectDeleteAuditMetadata(pendingAudit?.metadata);

        if (!pendingAudit || !metadata) {
          throw new NotFoundException('Training project not found');
        }

        return { auditId: pendingAudit.id, metadata };
      }

      const materialRevisions = await transaction.trainingMaterialRevision.findMany({
        where: { material: { projectId } },
        select: { id: true, previousRevisionId: true, fileId: true },
      });
      const revisionDeletionLayers = getRevisionDeletionLayers(materialRevisions);
      const mergedAnswerFiles = await transaction.trainingAnswer.findMany({
        where: { attemptQuestion: { attempt: { projectId } } },
        select: { id: true, mergedAudioFileId: true },
      });
      const segmentFiles = await transaction.trainingAnswerSegment.findMany({
        where: { answer: { attemptQuestion: { attempt: { projectId } } } },
        select: { id: true, answerId: true, storedFileId: true },
      });
      const candidateFileIds = [...new Set([
        ...materialRevisions.map((revision) => revision.fileId),
        ...mergedAnswerFiles.map((file) => file.mergedAudioFileId),
        ...segmentFiles.map((file) => file.storedFileId),
      ].filter((fileId): fileId is string => Boolean(fileId)))];
      await this.lockDeletionFiles(transaction, candidateFileIds);

      await transaction.trainingAnswerSegment.deleteMany({
        where: { answer: { attemptQuestion: { attempt: { projectId } } } },
      });
      await transaction.trainingAnswer.deleteMany({
        where: { attemptQuestion: { attempt: { projectId } } },
      });
      await transaction.trainingAttemptQuestion.deleteMany({
        where: { attempt: { projectId } },
      });
      await transaction.trainingAttempt.deleteMany({ where: { projectId } });
      await transaction.trainingTelegramLinkToken.deleteMany({ where: { projectId } });
      await transaction.trainingProjectAssignment.deleteMany({ where: { projectId } });
      await transaction.trainingFact.deleteMany({
        where: { question: { projectId } },
      });
      for (const revisionIds of revisionDeletionLayers) {
        await transaction.trainingMaterialRevision.deleteMany({
          where: { id: { in: revisionIds } },
        });
      }
      await transaction.trainingMaterial.deleteMany({ where: { projectId } });
      await transaction.trainingCriterion.deleteMany({ where: { projectId } });
      await transaction.trainingQuestion.deleteMany({ where: { projectId } });

      const candidateFiles = await transaction.file.findMany({
        where: { id: { in: candidateFileIds } },
        select: projectDeletionFileSelect,
      });
      const unlinkedFiles = candidateFiles.filter(isProjectDeletionFileUnlinked);
      if (unlinkedFiles.length) {
        await transaction.file.deleteMany({
          where: { id: { in: unlinkedFiles.map((file) => file.id) } },
        });
      }
      const deletedFileIds = new Set(unlinkedFiles.map((file) => file.id));
      const trainingAudioBucket = getTrainingAudioBucket();
      const expectedAudioObjects: StoredObjectCleanup[] = trainingAudioBucket
        ? [
            ...mergedAnswerFiles
              .filter(
                (answer) =>
                  !answer.mergedAudioFileId || deletedFileIds.has(answer.mergedAudioFileId),
              )
              .map((answer) => ({
                key: `training-v2/answers/${answer.id}/merged.wav`,
                bucket: trainingAudioBucket,
              })),
            ...segmentFiles
              .filter(
                (segment) =>
                  !segment.storedFileId || deletedFileIds.has(segment.storedFileId),
              )
              .map((segment) => ({
                key: `training-v2/answers/${segment.answerId}/segments/${segment.id}.ogg`,
                bucket: trainingAudioBucket,
              })),
          ]
        : [];

      const metadata: ProjectDeleteAuditMetadata = {
        title: project.title,
        attemptsCount: project._count.attempts,
        assignmentsCount: project._count.assignments,
        materialsCount: project._count.materials,
        cleanupStatus: 'PENDING',
        cleanupRevision: 0,
        storageObjects: dedupeStoredObjects(
          unlinkedFiles.flatMap((file) => [
            ...file.variants.map((variant) => ({
              key: variant.key,
              bucket: variant.bucket,
            })),
            { key: file.key, bucket: file.bucket },
          ]).concat(expectedAudioObjects),
        ),
      };
      const audit = await transaction.auditLog.create({
        data: {
          actorUserId,
          action: PROJECT_DELETE_AUDIT_ACTION,
          entityType: 'training_project',
          entityId: project.id,
          metadata,
        },
        select: { id: true },
      });
      await transaction.trainingProject.delete({ where: { id: projectId } });

      return { auditId: audit.id, metadata };
    }, {
      timeout: PROJECT_DELETE_TRANSACTION_TIMEOUT_MS,
    });

    const failedObjects: StoredObjectCleanup[] = [];
    for (
      let index = 0;
      index < cleanup.metadata.storageObjects.length;
      index += FILE_CLEANUP_CONCURRENCY
    ) {
      const objects = cleanup.metadata.storageObjects.slice(
        index,
        index + FILE_CLEANUP_CONCURRENCY,
      );
      const results = await Promise.allSettled(objects.map(async (object) => {
        if (object.fileId) {
          const result = await this.files.deleteUnlinkedFileWithResult(object.fileId);
          if (result === 'FAILED') throw new Error('File cleanup failed');
          if (result !== 'MISSING') return;
        }
        await this.files.deleteStoredObject(object.key, object.bucket);
      }));
      results.forEach((result, resultIndex) => {
        const object = objects[resultIndex];
        if (result.status === 'rejected' && object) failedObjects.push(object);
      });
    }

    if (failedObjects.length) {
      throw new ServiceUnavailableException(
        'Training project deleted, file cleanup is pending',
      );
    }

    if (!(await this.completeProjectDeleteAudit(cleanup.auditId, cleanup.metadata))) {
      throw new ServiceUnavailableException(
        'Training project deleted, file cleanup is pending',
      );
    }
  }

  async updateDraft(
    projectId: string,
    input: UpdateTrainingProjectDraftInput,
    actorUserId?: string,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockProject(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        include: adminProjectInclude,
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

      if (project.isOpen) {
        throw new ConflictException('Close the training project before editing');
      }

      if (project.accessMode !== input.accessMode && !actorUserId) {
        throw new ConflictException('Access mode changes require an authenticated actor');
      }

      const knowledgeChanged = currentKnowledgeDigest(project) !== inputKnowledgeDigest(input);

      await this.ensureRealEstateObjectExists(input.realEstateObjectId, transaction);
      await transaction.trainingProject.update({
        where: { id: projectId },
        data: {
          realEstateObjectId: input.realEstateObjectId,
          title: input.title,
          description: input.description,
          status: TrainingProjectStatus.DRAFT,
          isOpen: false,
          sortOrder: input.sortOrder,
          attemptLimit: input.attemptLimit,
          timeLimitSeconds: input.timeLimitSeconds,
          passScore: input.passScore,
          allowRetakeAfterPass: input.allowRetakeAfterPass,
          accessMode: input.accessMode,
          contentSchemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION,
          ...(knowledgeChanged
            ? {
                knowledgeSourceHash: null,
                knowledgeVersion: { increment: 1 },
              }
            : {}),
        },
      });

      if (project.accessMode !== input.accessMode && actorUserId) {
        await transaction.auditLog.create({
          data: {
            actorUserId,
            action: 'training.project_access_mode.update',
            entityType: 'training_project',
            entityId: projectId,
            metadata: { from: project.accessMode, to: input.accessMode },
          },
        });
      }

      const questions = [
        await this.upsertQuestion(
          transaction,
          projectId,
          TrainingQuestionType.MAIN,
          1,
          input.mainQuestion,
        ),
      ];

      for (const [index, text] of input.followUpQuestions.entries()) {
        questions.push(
          await this.upsertQuestion(
            transaction,
            projectId,
            TrainingQuestionType.FOLLOW_UP,
            index + 1,
            text,
          ),
        );
      }

      await this.replaceFacts(transaction, projectId, questions, input.facts);
      await this.replaceCriteria(transaction, projectId, input.criteria);
    });

    return this.getAdminProject(projectId);
  }

  async publishProject(projectId: string) {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockProject(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        include: adminProjectInclude,
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

      if (project.isOpen) {
        throw new ConflictException('Open training project cannot be published again');
      }

      this.validatePublication(project);
      await transaction.trainingProject.update({
        where: { id: projectId },
        data: { status: TrainingProjectStatus.PUBLISHED },
      });
    });

    return this.getAdminProject(projectId);
  }

  async setAvailability(projectId: string, isOpen: boolean) {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockProject(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        include: adminProjectInclude,
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

      if (isOpen && project.status !== TrainingProjectStatus.PUBLISHED) {
        throw new ConflictException('Only a published training project can be opened');
      }

      if (isOpen && project.contentSchemaVersion >= TRAINING_STAGE3_SNAPSHOT_SCHEMA_VERSION) {
        this.validatePublication(project);
      }

      await transaction.trainingProject.update({
        where: { id: projectId },
        data: { isOpen },
      });
    });

    return this.getAdminProject(projectId);
  }

  validatePublication(project: AdminProjectRecord) {
    const errors = this.getPublicationErrors(project);

    if (errors.length) {
      throw new BadRequestException(errors.join('; '));
    }
  }

  getPublicationErrors(project: AdminProjectRecord) {
    const errors: string[] = [];
    const activeQuestions = project.questions.filter((question) => question.isActive);
    const mainQuestions = activeQuestions.filter(
      (question) => question.type === TrainingQuestionType.MAIN && question.text.trim(),
    );
    const followUpQuestions = activeQuestions.filter(
      (question) => question.type === TrainingQuestionType.FOLLOW_UP && question.text.trim(),
    );

    if (!project.title.trim()) errors.push('Укажите название проекта.');
    if (project.attemptLimit < 1 || project.timeLimitSeconds < 1) {
      errors.push('Лимит попыток и таймер должны быть положительными.');
    }
    if (project.passScore < 0 || project.passScore > 100) {
      errors.push('Проходной балл должен быть от 0 до 100.');
    }
    if (
      mainQuestions.length !== 1 ||
      followUpQuestions.length !== TRAINING_SNAPSHOT_FOLLOW_UP_COUNT
    ) {
      errors.push(
        `Нужны 1 главный и ${TRAINING_SNAPSHOT_FOLLOW_UP_COUNT} дополнительных вопросов.`,
      );
    }
    if (project.contentSchemaVersion >= TRAINING_STAGE3_SNAPSHOT_SCHEMA_VERSION) {
      for (const question of activeQuestions) {
        if (!question.facts.some((fact) => fact.isActive)) {
          errors.push(
            `Добавьте хотя бы один утверждённый факт для ${question.type === TrainingQuestionType.MAIN ? 'главного' : `дополнительного вопроса ${question.position}`}.`,
          );
        }
      }

      const activeCriteria = project.criteria.filter((criterion) => criterion.isActive);
      const mainTotal = activeCriteria
        .filter((criterion) => criterion.questionType === TrainingQuestionType.MAIN)
        .reduce((total, criterion) => total + criterion.maxPoints, 0);
      const followUpTotal = activeCriteria
        .filter((criterion) => criterion.questionType === TrainingQuestionType.FOLLOW_UP)
        .reduce((total, criterion) => total + criterion.maxPoints, 0);

      if (mainTotal !== 55) {
        errors.push(`Сумма критериев главного вопроса должна быть 55, сейчас ${mainTotal}.`);
      }
      if (followUpTotal !== 15) {
        errors.push(`Сумма критериев дополнительных вопросов должна быть 15, сейчас ${followUpTotal}.`);
      }
    }

    return errors;
  }

  private serializeAdminProject(project: AdminProjectRecord): TrainingAdminProject {
    const mainQuestion = project.questions.find(
      (question) => question.type === TrainingQuestionType.MAIN && question.isActive,
    );
    const followUpQuestions = project.questions
      .filter(
        (question) => question.type === TrainingQuestionType.FOLLOW_UP && question.isActive,
      )
      .sort((left, right) => left.position - right.position);

    return {
      id: project.id,
      realEstateObjectId: project.realEstateObjectId,
      title: project.title,
      description: project.description,
      status: project.status,
      accessMode: project.accessMode,
      activeAssignments: project._count.assignments,
      isOpen: project.isOpen,
      sortOrder: project.sortOrder,
      attemptLimit: project.attemptLimit,
      timeLimitSeconds: project.timeLimitSeconds,
      passScore: project.passScore,
      allowRetakeAfterPass: project.allowRetakeAfterPass,
      contentSchemaVersion: project.contentSchemaVersion,
      mainQuestion: mainQuestion?.text ?? '',
      followUpQuestions: followUpQuestions.map((question) => question.text),
      facts: project.questions
        .flatMap((question) =>
          question.facts.map((fact) => ({
            id: fact.id,
            questionType: question.type,
            questionPosition: question.position,
            statement: fact.statement,
            aliases: parseAliasesJson(fact.aliasesJson),
            isRequired: fact.isRequired,
            position: fact.position,
            sourceType: fact.sourceType,
            sourceRevisionId: fact.sourceRevisionId,
            sourceLabel: fact.sourceLabel,
            sourceLocator: fact.sourceLocator,
            sourceExcerpt: fact.sourceExcerpt,
            sourceMaterialType: fact.sourceRevision?.material.type ?? null,
            sourceUrl: fact.sourceRevision?.finalUrl ?? fact.sourceRevision?.material.sourceUrl ?? null,
          })),
        )
        .sort(compareDraftItems),
      criteria: project.criteria
        .filter((criterion) => criterion.isActive)
        .map((criterion) => ({
          id: criterion.id,
          questionType: criterion.questionType,
          code: criterion.code,
          title: criterion.title,
          guidance: criterion.guidance,
          maxPoints: criterion.maxPoints,
          position: criterion.position,
        }))
        .sort(compareDraftItems),
      publicationErrors: this.getPublicationErrors(project),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  private async replaceFacts(
    transaction: Prisma.TransactionClient,
    projectId: string,
    questions: Array<{ id: string; type: TrainingQuestionType; position: number }>,
    facts: TrainingFactDraftInput[],
  ) {
    await this.assertDraftIdsBelongToProject(
      transaction,
      'fact',
      projectId,
      facts.flatMap((fact) => (fact.id ? [fact.id] : [])),
    );
    const existingFacts = facts.some((fact) => fact.id)
      ? await transaction.trainingFact.findMany({
          where: {
            id: { in: facts.flatMap((fact) => (fact.id ? [fact.id] : [])) },
            question: { projectId },
          },
          select: {
            id: true,
            sourceType: true,
            sourceRevisionId: true,
            sourceLabel: true,
            sourceLocator: true,
            sourceExcerpt: true,
          },
        })
      : [];
    const existingById = new Map(existingFacts.map((fact) => [fact.id, fact]));
    const questionByKey = new Map(
      questions.map((question) => [draftKey(question.type, question.position), question]),
    );

    await transaction.trainingFact.deleteMany({
      where: { question: { projectId } },
    });
    if (!facts.length) return;

    await transaction.trainingFact.createMany({
      data: facts.map((fact) => {
        const question = questionByKey.get(draftKey(fact.questionType, fact.questionPosition));

        if (!question) throw new BadRequestException('Training fact question is invalid');

        const source = fact.id ? existingById.get(fact.id) : null;

        return {
          id: fact.id ?? randomUUID(),
          questionId: question.id,
          statement: fact.statement,
          aliasesJson: fact.aliases as Prisma.InputJsonValue,
          isRequired: fact.isRequired,
          position: fact.position,
          isActive: true,
          sourceType: source?.sourceType ?? 'MANUAL',
          sourceRevisionId: source?.sourceRevisionId ?? null,
          sourceLabel: source?.sourceLabel ?? 'Добавлено вручную',
          sourceLocator: source?.sourceLocator ?? null,
          sourceExcerpt: source?.sourceExcerpt ?? null,
        };
      }),
    });
  }

  private async replaceCriteria(
    transaction: Prisma.TransactionClient,
    projectId: string,
    criteria: TrainingCriterionDraftInput[],
  ) {
    await this.assertDraftIdsBelongToProject(
      transaction,
      'criterion',
      projectId,
      criteria.flatMap((criterion) => (criterion.id ? [criterion.id] : [])),
    );
    await transaction.trainingCriterion.deleteMany({ where: { projectId } });

    if (!criteria.length) return;

    await transaction.trainingCriterion.createMany({
      data: criteria.map((criterion) => ({
        id: criterion.id ?? randomUUID(),
        projectId,
        questionType: criterion.questionType,
        code: criterion.code,
        title: criterion.title,
        guidance: criterion.guidance,
        maxPoints: criterion.maxPoints,
        position: criterion.position,
        isActive: true,
      })),
    });
  }

  private async assertDraftIdsBelongToProject(
    transaction: Prisma.TransactionClient,
    kind: 'fact' | 'criterion',
    projectId: string,
    ids: string[],
  ) {
    if (!ids.length) return;

    const count = kind === 'fact'
      ? await transaction.trainingFact.count({
          where: { id: { in: ids }, question: { projectId } },
        })
      : await transaction.trainingCriterion.count({
          where: { id: { in: ids }, projectId },
        });

    if (count !== new Set(ids).size) {
      throw new BadRequestException(`Training ${kind} ID does not belong to the project`);
    }
  }

  private async upsertQuestion(
    transaction: Prisma.TransactionClient,
    projectId: string,
    type: TrainingQuestionType,
    position: number,
    text: string,
  ) {
    return transaction.trainingQuestion.upsert({
      where: {
        projectId_type_position: { projectId, type, position },
      },
      update: { text, isActive: true },
      create: { projectId, type, position, text, isActive: true },
      select: { id: true, type: true, position: true },
    });
  }

  private async lockActor(transaction: Prisma.TransactionClient, actorUserId: string) {
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = CAST(${actorUserId} AS uuid) FOR SHARE`,
    );
  }

  private async lockProject(transaction: Prisma.TransactionClient, projectId: string) {
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "training_projects" WHERE "id" = CAST(${projectId} AS uuid) FOR UPDATE`,
    );
  }

  private async lockDeletionFiles(
    transaction: Prisma.TransactionClient,
    fileIds: string[],
  ) {
    if (!fileIds.length) return;

    await transaction.$queryRaw(Prisma.sql`
      SELECT "id"
      FROM "files"
      WHERE "id" IN (${Prisma.join(
        fileIds.map((fileId) => Prisma.sql`CAST(${fileId} AS uuid)`),
      )})
      ORDER BY "id"
      FOR UPDATE
    `);
  }

  private async lockProjectDeletionGraph(
    transaction: Prisma.TransactionClient,
    projectId: string,
  ) {
    await this.lockProject(transaction, projectId);
    await transaction.$queryRaw(Prisma.sql`
      SELECT attempt."id"
      FROM "training_attempts" AS attempt
      WHERE attempt."project_id" = CAST(${projectId} AS uuid)
      ORDER BY attempt."id"
      FOR UPDATE OF attempt
    `);
    await transaction.$queryRaw(Prisma.sql`
      SELECT question."id"
      FROM "training_attempt_questions" AS question
      JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
      WHERE attempt."project_id" = CAST(${projectId} AS uuid)
      ORDER BY question."id"
      FOR UPDATE OF question
    `);
    await transaction.$queryRaw(Prisma.sql`
      SELECT answer."id"
      FROM "training_answers" AS answer
      JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
      JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
      WHERE attempt."project_id" = CAST(${projectId} AS uuid)
      ORDER BY answer."id"
      FOR UPDATE OF answer
    `);
    await transaction.$queryRaw(Prisma.sql`
      SELECT segment."id"
      FROM "training_answer_segments" AS segment
      JOIN "training_answers" AS answer ON answer."id" = segment."answer_id"
      JOIN "training_attempt_questions" AS question ON question."id" = answer."attempt_question_id"
      JOIN "training_attempts" AS attempt ON attempt."id" = question."attempt_id"
      WHERE attempt."project_id" = CAST(${projectId} AS uuid)
      ORDER BY segment."id"
      FOR UPDATE OF segment
    `);
    await transaction.$queryRaw(Prisma.sql`
      SELECT material."id"
      FROM "training_materials" AS material
      WHERE material."project_id" = CAST(${projectId} AS uuid)
      ORDER BY material."id"
      FOR UPDATE OF material
    `);
    await transaction.$queryRaw(Prisma.sql`
      SELECT revision."id"
      FROM "training_material_revisions" AS revision
      JOIN "training_materials" AS material ON material."id" = revision."material_id"
      WHERE material."project_id" = CAST(${projectId} AS uuid)
      ORDER BY revision."id"
      FOR UPDATE OF revision
    `);
  }

  private async completeProjectDeleteAudit(
    auditId: string,
    cleanedMetadata: ProjectDeleteAuditMetadata,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT "id" FROM "audit_logs" WHERE "id" = CAST(${auditId} AS uuid) FOR UPDATE`,
      );
      const audit = await transaction.auditLog.findUnique({
        where: { id: auditId },
        select: { metadata: true },
      });
      const latestMetadata = parseProjectDeleteAuditMetadata(audit?.metadata);

      if (
        !latestMetadata ||
        latestMetadata.cleanupRevision !== cleanedMetadata.cleanupRevision ||
        !hasSameStoredObjects(latestMetadata.storageObjects, cleanedMetadata.storageObjects)
      ) {
        return false;
      }

      await transaction.auditLog.update({
        where: { id: auditId },
        data: {
          metadata: {
            ...latestMetadata,
            cleanupStatus: 'COMPLETED',
            cleanupCompletedAt: new Date().toISOString(),
          },
        },
      });
      return true;
    });
  }

  private async ensureRealEstateObjectExists(
    realEstateObjectId: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!realEstateObjectId) return;

    const object = await client.realEstateObject.findUnique({
      where: { id: realEstateObjectId },
      select: { id: true },
    });

    if (!object) {
      throw new BadRequestException('Real estate object not found');
    }
  }
}

function isProjectDeletionFileUnlinked(file: ProjectDeletionFile) {
  return (
    file._count.profilePhotoUsers === 0 &&
    file._count.objectImages === 0 &&
    file._count.objectFiles === 0 &&
    file._count.feedXmlSources === 0 &&
    file._count.feedMediaAssets === 0 &&
    file._count.lotPresentationDocuments === 0 &&
    file._count.projectPresentationDraftCovers === 0 &&
    file._count.projectPresentationDocuments === 0 &&
    file._count.projectPresentationAssets === 0 &&
    file._count.trainingAnswerSegments === 0 &&
    file._count.trainingMergedAnswers === 0 &&
    file._count.trainingMaterialRevisions === 0
  );
}

function dedupeStoredObjects(objects: StoredObjectCleanup[]) {
  const unique = new Map<string, StoredObjectCleanup>();
  for (const object of objects) {
    const id = `${object.bucket ?? ''}\0${object.key}`;
    const current = unique.get(id);
    if (!current || (!current.fileId && object.fileId)) unique.set(id, object);
  }
  return [...unique.values()];
}

function hasSameStoredObjects(
  left: StoredObjectCleanup[],
  right: StoredObjectCleanup[],
) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(
    right.map(
      (object) => `${object.bucket ?? ''}\0${object.key}\0${object.fileId ?? ''}`,
    ),
  );
  return left.every((object) =>
    rightIds.has(`${object.bucket ?? ''}\0${object.key}\0${object.fileId ?? ''}`),
  );
}

function getTrainingAudioBucket() {
  const bucket = (process.env.TRAINING_AUDIO_BUCKET ?? 'platforma-training-audio').trim();
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ? bucket : null;
}

function parseProjectDeleteAuditMetadata(
  value: Prisma.JsonValue | null | undefined,
): ProjectDeleteAuditMetadata | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;

  const metadata = value as Record<string, Prisma.JsonValue>;
  if (
    typeof metadata.title !== 'string' ||
    typeof metadata.attemptsCount !== 'number' ||
    typeof metadata.assignmentsCount !== 'number' ||
    typeof metadata.materialsCount !== 'number' ||
    (metadata.cleanupStatus !== 'PENDING' && metadata.cleanupStatus !== 'COMPLETED') ||
    !Array.isArray(metadata.storageObjects)
  ) {
    return null;
  }

  const storageObjects: StoredObjectCleanup[] = [];
  for (const item of metadata.storageObjects) {
    if (
      !item ||
      Array.isArray(item) ||
      typeof item !== 'object' ||
      typeof item.key !== 'string' ||
      (item.bucket !== null && typeof item.bucket !== 'string')
    ) {
      return null;
    }
    if (item.fileId !== undefined && typeof item.fileId !== 'string') return null;
    storageObjects.push({
      key: item.key,
      bucket: item.bucket,
      ...(typeof item.fileId === 'string' ? { fileId: item.fileId } : {}),
    });
  }

  return {
    title: metadata.title,
    attemptsCount: metadata.attemptsCount,
    assignmentsCount: metadata.assignmentsCount,
    materialsCount: metadata.materialsCount,
    cleanupStatus: metadata.cleanupStatus,
    cleanupRevision:
      typeof metadata.cleanupRevision === 'number' ? metadata.cleanupRevision : 0,
    storageObjects,
    ...(typeof metadata.cleanupCompletedAt === 'string'
      ? { cleanupCompletedAt: metadata.cleanupCompletedAt }
      : {}),
  };
}

function currentKnowledgeDigest(project: AdminProjectRecord) {
  return knowledgeDigest({
    questions: project.questions
      .filter((question) => question.isActive)
      .map((question) => ({
        type: question.type,
        position: question.position,
        text: question.text,
      })),
    facts: project.questions.flatMap((question) => question.facts
      .filter((fact) => fact.isActive)
      .map((fact) => ({
        questionType: question.type,
        questionPosition: question.position,
        position: fact.position,
        statement: fact.statement,
        aliases: parseAliasesJson(fact.aliasesJson),
        isRequired: fact.isRequired,
      }))),
    criteria: project.criteria
      .filter((criterion) => criterion.isActive)
      .map((criterion) => ({
        questionType: criterion.questionType,
        position: criterion.position,
        code: criterion.code,
        title: criterion.title,
        guidance: criterion.guidance,
        maxPoints: criterion.maxPoints,
      })),
  });
}

function inputKnowledgeDigest(input: UpdateTrainingProjectDraftInput) {
  return knowledgeDigest({
    questions: [
      { type: TrainingQuestionType.MAIN, position: 1, text: input.mainQuestion },
      ...input.followUpQuestions.map((text, index) => ({
        type: TrainingQuestionType.FOLLOW_UP,
        position: index + 1,
        text,
      })),
    ],
    facts: input.facts,
    criteria: input.criteria,
  });
}

function knowledgeDigest(value: {
  questions: Array<{ type: TrainingQuestionType; position: number; text: string }>;
  facts: Array<{
    questionType: TrainingQuestionType;
    questionPosition: number;
    position: number;
    statement: string;
    aliases: string[];
    isRequired: boolean;
  }>;
  criteria: Array<{
    questionType: TrainingQuestionType;
    position: number;
    code: string;
    title: string;
    guidance: string;
    maxPoints: number;
  }>;
}) {
  const canonical = {
    questions: value.questions.map((question) => ({
      ...question,
      text: normalizeKnowledgeText(question.text),
    })).sort(compareKnowledgeItems),
    facts: value.facts.map((fact) => ({
      questionType: fact.questionType,
      questionPosition: fact.questionPosition,
      position: fact.position,
      statement: normalizeKnowledgeText(fact.statement),
      aliases: fact.aliases.map(normalizeKnowledgeText),
      isRequired: fact.isRequired,
    })).sort((left, right) =>
      compareKnowledgeItems(
        { type: left.questionType, position: left.questionPosition },
        { type: right.questionType, position: right.questionPosition },
      ) || left.position - right.position,
    ),
    criteria: value.criteria.map((criterion) => ({
      ...criterion,
      code: normalizeKnowledgeText(criterion.code),
      title: normalizeKnowledgeText(criterion.title),
      guidance: normalizeKnowledgeText(criterion.guidance),
    })).sort((left, right) =>
      compareKnowledgeItems(
        { type: left.questionType, position: left.position },
        { type: right.questionType, position: right.position },
      ),
    ),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function compareKnowledgeItems(
  left: { type: TrainingQuestionType; position: number },
  right: { type: TrainingQuestionType; position: number },
) {
  return left.type === right.type
    ? left.position - right.position
    : left.type === TrainingQuestionType.MAIN ? -1 : 1;
}

function normalizeKnowledgeText(value: string) {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function parseAliasesJson(value: Prisma.JsonValue) {
  if (
    !Array.isArray(value) ||
    value.length > TRAINING_FACT_ALIAS_LIMIT ||
    value.some(
      (alias) =>
        typeof alias !== 'string' ||
        !alias.trim() ||
        alias.length > TRAINING_FACT_ALIAS_MAX_LENGTH,
    )
  ) {
    throw new Error('Invalid training fact aliases');
  }

  return value as string[];
}

function compareDraftItems(
  left: { questionType: TrainingQuestionType; position: number },
  right: { questionType: TrainingQuestionType; position: number },
) {
  if (left.questionType !== right.questionType) {
    return left.questionType === TrainingQuestionType.MAIN ? -1 : 1;
  }

  return left.position - right.position;
}

function draftKey(type: TrainingQuestionType, position: number) {
  return `${type}:${position}`;
}

function getRevisionDeletionLayers(
  revisions: Array<{ id: string; previousRevisionId: string | null }>,
) {
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  const childCount = new Map(revisions.map((revision) => [revision.id, 0]));

  for (const revision of revisions) {
    if (!revision.previousRevisionId) continue;
    if (!revisionById.has(revision.previousRevisionId)) {
      throw new ConflictException('Training material revision chain is invalid');
    }
    childCount.set(
      revision.previousRevisionId,
      (childCount.get(revision.previousRevisionId) ?? 0) + 1,
    );
  }

  const remaining = new Set(revisionById.keys());
  const layers: string[][] = [];

  while (remaining.size) {
    const leaves = [...remaining]
      .filter((revisionId) => childCount.get(revisionId) === 0)
      .sort();

    if (!leaves.length) {
      throw new ConflictException('Training material revision chain is invalid');
    }

    layers.push(leaves);
    for (const revisionId of leaves) {
      remaining.delete(revisionId);
      const previousRevisionId = revisionById.get(revisionId)?.previousRevisionId;
      if (previousRevisionId) {
        childCount.set(previousRevisionId, (childCount.get(previousRevisionId) ?? 1) - 1);
      }
    }
  }

  return layers;
}

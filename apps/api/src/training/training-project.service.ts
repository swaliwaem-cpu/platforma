import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingProjectStatus,
  TrainingQuestionType,
} from '@prisma/client';
import type {
  TrainingAdminProject,
  TrainingAdminProjectsResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
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
} as const satisfies Prisma.TrainingProjectInclude;

type AdminProjectRecord = Prisma.TrainingProjectGetPayload<{
  include: typeof adminProjectInclude;
}>;

@Injectable()
export class TrainingProjectService {
  constructor(private readonly prisma: PrismaService) {}

  async listAdminProjects(): Promise<TrainingAdminProjectsResponse> {
    const projects = await this.prisma.trainingProject.findMany({
      include: {
        _count: {
          select: {
            attempts: true,
            questions: true,
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

  async updateDraft(projectId: string, input: UpdateTrainingProjectDraftInput) {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockProject(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        select: { id: true, isOpen: true },
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

      if (project.isOpen) {
        throw new ConflictException('Close the training project before editing');
      }

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
          contentSchemaVersion: TRAINING_SNAPSHOT_SCHEMA_VERSION,
        },
      });

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
        errors.push(`Сумма MAIN criteria должна быть 55, сейчас ${mainTotal}.`);
      }
      if (followUpTotal !== 15) {
        errors.push(`Сумма FOLLOW_UP criteria должна быть 15, сейчас ${followUpTotal}.`);
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

  private async lockProject(transaction: Prisma.TransactionClient, projectId: string) {
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "training_projects" WHERE "id" = CAST(${projectId} AS uuid) FOR UPDATE`,
    );
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

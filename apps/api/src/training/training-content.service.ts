import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingVersionStatus,
} from '@prisma/client';

import type { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  TRAINING_FOLLOW_UP_MAX_SCORE,
  TRAINING_MAIN_MAX_SCORE,
} from './training.domain';
import {
  assertTrainingAvailability,
  assertTrainingVersionPublishable,
  normalizeTrainingUniqueKey,
} from './training-content.validation';

const trainingVersionContentInclude = {
  questions: {
    orderBy: [{ type: 'asc' }, { position: 'asc' }],
    include: {
      factLinks: {
        orderBy: { createdAt: 'asc' },
      },
    },
  },
  facts: {
    orderBy: [{ topicCode: 'asc' }, { code: 'asc' }],
  },
  criteria: {
    orderBy: [{ questionType: 'asc' }, { sortOrder: 'asc' }],
  },
  sourceDocuments: {
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.TrainingProjectVersionInclude;

const trainingVersionDetailInclude = {
  ...trainingVersionContentInclude,
  sourceDocuments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      projectVersionId: true,
      fileId: true,
      documentType: true,
      checksum: true,
      extractionStatus: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  publishedBy: {
    select: {
      id: true,
      email: true,
      name: true,
    },
  },
} satisfies Prisma.TrainingProjectVersionInclude;

const trainingProjectDetailInclude = {
  realEstateObject: {
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
    },
  },
  versions: {
    orderBy: { versionNumber: 'desc' },
    include: trainingVersionDetailInclude,
  },
} satisfies Prisma.TrainingProjectInclude;

const trainingProjectListInclude = {
  realEstateObject: {
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
    },
  },
  activeVersion: {
    select: {
      id: true,
      versionNumber: true,
      status: true,
      passScore: true,
      attemptLimit: true,
      cooldownMinutes: true,
      totalTimeLimitSeconds: true,
      allowRetakeAfterPass: true,
      publishedAt: true,
    },
  },
  versions: {
    orderBy: { versionNumber: 'desc' },
    select: {
      id: true,
      versionNumber: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      publishedAt: true,
    },
  },
  _count: {
    select: {
      attempts: true,
    },
  },
} satisfies Prisma.TrainingProjectInclude;

type TrainingVersionContentRecord = Prisma.TrainingProjectVersionGetPayload<{
  include: typeof trainingVersionContentInclude;
}>;

type TrainingTransaction = Prisma.TransactionClient;

export type TrainingAuditRequest = RequestWithAuth & {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
};

type VersionSettings = {
  passScore: number;
  attemptLimit: number;
  cooldownMinutes: number;
  totalTimeLimitSeconds: number;
  finishGraceSeconds: number;
  warningSecondsJson: Prisma.InputJsonValue;
  allowRetakeAfterPass: boolean;
  mainMaxScore: number;
  followUpMaxScore: number;
  scoringConfigJson: Prisma.InputJsonValue;
  promptVersion: string;
  schemaVersion: string;
};

@Injectable()
export class TrainingContentService {
  constructor(private readonly prisma: PrismaService) {}

  async listProjects(query: Record<string, string | undefined>) {
    const page = this.parsePositiveInteger(query.page, 'Page', 1);
    const limit = this.parsePositiveInteger(query.limit, 'Limit', 20, 100);
    const search = this.parseOptionalQueryString(query.search, 'Search', 200);
    const status = query.status
      ? this.parseProjectStatus(query.status, 'Project status')
      : undefined;
    const where: Prisma.TrainingProjectWhereInput = {};

    if (status) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { realEstateObject: { title: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.trainingProject.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: trainingProjectListInclude,
      }),
      this.prisma.trainingProject.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getProject(id: string) {
    const projectId = this.parseUuid(id, 'Training project is invalid');
    const project = await this.prisma.trainingProject.findUnique({
      where: { id: projectId },
      include: trainingProjectDetailInclude,
    });

    if (!project) {
      throw new NotFoundException('Training project not found');
    }

    return { project };
  }

  async createProject(
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    this.assertOnlyFields(body, [
      'title',
      'slug',
      'description',
      'realEstateObjectId',
      'sortOrder',
      'availableFrom',
      'deadlineAt',
      'draft',
    ]);
    const title = this.parseRequiredString(body.title, 'Title is required', 240);
    const slug = this.parseSlug(body.slug);
    const description = this.parseNullableString(body.description, 'Description', 2000);
    const realEstateObjectId = this.parseNullableUuid(
      body.realEstateObjectId,
      'Real estate object is invalid',
    );
    const sortOrder = this.parseNonNegativeInteger(body.sortOrder, 'Sort order', 0);
    const availableFrom = this.parseNullableDate(body.availableFrom, 'Available from');
    const deadlineAt = this.parseNullableDate(body.deadlineAt, 'Deadline');
    const draftInput =
      body.draft === undefined ? {} : this.parseObject(body.draft, 'Draft settings are invalid');
    this.assertOnlyVersionSettingFields(draftInput, false);
    const settings = this.parseVersionSettings(draftInput);

    assertTrainingAvailability(availableFrom, deadlineAt);
    await this.ensureRealEstateObjectExists(realEstateObjectId);

    let projectId: string;
    try {
      projectId = await this.prisma.$transaction(async (tx) => {
        const project = await tx.trainingProject.create({
          data: {
            title,
            slug,
            description,
            realEstateObjectId,
            sortOrder,
            availableFrom,
            deadlineAt,
          },
          select: { id: true },
        });
        const version = await tx.trainingProjectVersion.create({
          data: {
            projectId: project.id,
            versionNumber: 1,
            ...settings,
          },
          select: { id: true },
        });

        await this.writeAudit(tx, {
          action: 'training.project.create',
          actor,
          request,
          entityType: 'training_project',
          entityId: project.id,
          metadata: {
            title,
            slug,
            draftVersionId: version.id,
            draftVersionNumber: 1,
          },
        });

        return project.id;
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Training project slug already exists');
    }

    return this.getProject(projectId!);
  }

  async updateProject(
    id: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const projectId = this.parseUuid(id, 'Training project is invalid');
    this.assertOnlyFields(
      body,
      [
        'title',
        'slug',
        'description',
        'realEstateObjectId',
        'sortOrder',
        'availableFrom',
        'deadlineAt',
      ],
      true,
    );
    const current = await this.prisma.trainingProject.findUnique({ where: { id: projectId } });

    if (!current) {
      throw new NotFoundException('Training project not found');
    }
    if (current.status === TrainingProjectStatus.ARCHIVED) {
      throw new ConflictException('Archived training project is immutable');
    }

    const data: Prisma.TrainingProjectUpdateInput = {};
    const changedFields: string[] = [];
    if (this.hasOwn(body, 'title')) {
      data.title = this.parseRequiredString(body.title, 'Title is required', 240);
      changedFields.push('title');
    }
    if (this.hasOwn(body, 'slug')) {
      data.slug = this.parseSlug(body.slug);
      changedFields.push('slug');
    }
    if (this.hasOwn(body, 'description')) {
      data.description = this.parseNullableString(body.description, 'Description', 2000);
      changedFields.push('description');
    }
    if (this.hasOwn(body, 'realEstateObjectId')) {
      const realEstateObjectId = this.parseNullableUuid(
        body.realEstateObjectId,
        'Real estate object is invalid',
      );
      await this.ensureRealEstateObjectExists(realEstateObjectId);
      data.realEstateObject =
        realEstateObjectId === null
          ? { disconnect: true }
          : { connect: { id: realEstateObjectId } };
      changedFields.push('realEstateObjectId');
    }
    if (this.hasOwn(body, 'sortOrder')) {
      data.sortOrder = this.parseNonNegativeInteger(body.sortOrder, 'Sort order');
      changedFields.push('sortOrder');
    }

    const availableFrom = this.hasOwn(body, 'availableFrom')
      ? this.parseNullableDate(body.availableFrom, 'Available from')
      : current.availableFrom;
    const deadlineAt = this.hasOwn(body, 'deadlineAt')
      ? this.parseNullableDate(body.deadlineAt, 'Deadline')
      : current.deadlineAt;
    if (this.hasOwn(body, 'availableFrom') || this.hasOwn(body, 'deadlineAt')) {
      assertTrainingAvailability(availableFrom, deadlineAt);
      data.availableFrom = availableFrom;
      data.deadlineAt = deadlineAt;
      changedFields.push('availability');
    }

    if (changedFields.length === 0) {
      throw new BadRequestException('No supported training project fields were provided');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.trainingProject.update({ where: { id: projectId }, data });
        await this.writeAudit(tx, {
          action: 'training.project.update',
          actor,
          request,
          entityType: 'training_project',
          entityId: projectId,
          metadata: { changedFields },
        });
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Training project slug already exists');
    }

    return this.getProject(projectId);
  }

  async createDraftVersion(
    projectIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const projectId = this.parseUuid(projectIdInput, 'Training project is invalid');
    let versionId: string;

    try {
      versionId = await this.prisma.$transaction(async (tx) => {
        const project = await tx.trainingProject.findUnique({
          where: { id: projectId },
          select: { id: true, status: true, activeVersionId: true },
        });

        if (!project) {
          throw new NotFoundException('Training project not found');
        }
        if (project.status === TrainingProjectStatus.ARCHIVED) {
          throw new ConflictException('Archived training project cannot receive a new draft');
        }

        const existingDraft = await tx.trainingProjectVersion.findFirst({
          where: { projectId, status: TrainingVersionStatus.DRAFT },
          select: { id: true },
        });
        if (existingDraft) {
          throw new ConflictException('Training project already has a draft version');
        }

        const latestVersion = await tx.trainingProjectVersion.findFirst({
          where: { projectId },
          orderBy: { versionNumber: 'desc' },
          include: trainingVersionContentInclude,
        });
        const versionNumber = (latestVersion?.versionNumber ?? 0) + 1;
        const settings = latestVersion
          ? this.copyVersionSettings(latestVersion)
          : this.parseVersionSettings({});
        const version = await tx.trainingProjectVersion.create({
          data: {
            projectId,
            versionNumber,
            ...settings,
          },
          select: { id: true },
        });

        if (latestVersion) {
          await this.cloneVersionContent(tx, latestVersion, version.id);
        }

        await this.writeAudit(tx, {
          action: 'training.version.draft.create',
          actor,
          request,
          entityType: 'training_project_version',
          entityId: version.id,
          metadata: {
            projectId,
            versionNumber,
            clonedFromVersionId: latestVersion?.id ?? null,
          },
        });

        return version.id;
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Training project already has a draft version');
    }

    return this.getVersion(versionId!);
  }

  async getVersion(id: string) {
    const versionId = this.parseUuid(id, 'Training version is invalid');
    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
      include: {
        ...trainingVersionDetailInclude,
        project: {
          select: {
            id: true,
            title: true,
            slug: true,
            status: true,
            availableFrom: true,
            deadlineAt: true,
            activeVersionId: true,
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('Training version not found');
    }

    return { version };
  }

  async updateVersion(
    id: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(id, 'Training version is invalid');
    this.assertOnlyVersionSettingFields(body, true);
    const current = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
    });

    this.assertDraftVersion(current);
    const settings = this.parseVersionSettings(body, this.copyVersionSettings(current!));
    const changedFields = Object.keys(body);
    if (changedFields.length === 0) {
      throw new BadRequestException('No training version settings were provided');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.trainingProjectVersion.update({
        where: { id: versionId },
        data: settings,
      });
      await this.writeAudit(tx, {
        action: 'training.version.update',
        actor,
        request,
        entityType: 'training_project_version',
        entityId: versionId,
        metadata: {
          projectId: current!.projectId,
          changedFields,
        },
      });
    });

    return this.getVersion(versionId);
  }

  async deleteDraftVersion(
    id: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(id, 'Training version is invalid');

    await this.prisma.$transaction(async (tx) => {
      const version = await tx.trainingProjectVersion.findUnique({
        where: { id: versionId },
        include: {
          _count: {
            select: { attempts: true },
          },
          activeForProject: {
            select: { id: true },
          },
        },
      });

      this.assertDraftVersion(version);
      if (version!._count.attempts > 0 || version!.activeForProject !== null) {
        throw new ConflictException('Used training version cannot be deleted');
      }

      await tx.trainingProjectVersion.delete({ where: { id: versionId } });
      await this.writeAudit(tx, {
        action: 'training.version.draft.delete',
        actor,
        request,
        entityType: 'training_project_version',
        entityId: versionId,
        metadata: {
          projectId: version!.projectId,
          versionNumber: version!.versionNumber,
        },
      });
    });
  }

  async listQuestions(versionIdInput: string) {
    const versionId = await this.requireVersionId(versionIdInput);
    const items = await this.prisma.trainingQuestion.findMany({
      where: { projectVersionId: versionId },
      orderBy: [{ type: 'asc' }, { position: 'asc' }],
      include: {
        factLinks: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return { items };
  }

  async createQuestion(
    versionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    this.assertOnlyFields(
      body,
      ['type', 'text', 'position', 'isActive', 'maxScore', 'topicCodes'],
      true,
    );
    const data = this.parseQuestionInput(body);
    let questionId: string;

    try {
      questionId = await this.prisma.$transaction(async (tx) => {
        const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
        this.assertDraftVersion(version);
        const question = await tx.trainingQuestion.create({
          data: {
            projectVersionId: versionId,
            ...data,
          },
          select: { id: true },
        });
        await this.writeAudit(tx, {
          action: 'training.question.create',
          actor,
          request,
          entityType: 'training_question',
          entityId: question.id,
          metadata: {
            projectVersionId: versionId,
            type: data.type,
            position: data.position,
          },
        });
        return question.id;
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Question position already exists');
    }

    return this.getQuestion(versionId, questionId!);
  }

  async updateQuestion(
    versionIdInput: string,
    questionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const questionId = this.parseUuid(questionIdInput, 'Training question is invalid');
    this.assertOnlyFields(
      body,
      ['type', 'text', 'position', 'isActive', 'maxScore', 'topicCodes'],
      true,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        const question = await tx.trainingQuestion.findFirst({
          where: { id: questionId, projectVersionId: versionId },
        });
        if (!question) {
          throw new NotFoundException('Training question not found');
        }
        const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
        this.assertDraftVersion(version);
        const data = this.parseQuestionInput(body, question);
        await tx.trainingQuestion.update({ where: { id: questionId }, data });
        await this.writeAudit(tx, {
          action: 'training.question.update',
          actor,
          request,
          entityType: 'training_question',
          entityId: questionId,
          metadata: {
            projectVersionId: versionId,
            changedFields: Object.keys(body),
          },
        });
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Question position already exists');
    }

    return this.getQuestion(versionId, questionId);
  }

  async deleteQuestion(
    versionIdInput: string,
    questionIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const questionId = this.parseUuid(questionIdInput, 'Training question is invalid');

    await this.prisma.$transaction(async (tx) => {
      const question = await tx.trainingQuestion.findFirst({
        where: { id: questionId, projectVersionId: versionId },
        include: {
          _count: {
            select: { attemptQuestions: true },
          },
        },
      });
      if (!question) {
        throw new NotFoundException('Training question not found');
      }
      const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
      this.assertDraftVersion(version);
      if (question._count.attemptQuestions > 0) {
        throw new ConflictException('Used training question cannot be deleted');
      }

      await tx.trainingQuestion.delete({ where: { id: questionId } });
      await this.writeAudit(tx, {
        action: 'training.question.delete',
        actor,
        request,
        entityType: 'training_question',
        entityId: questionId,
        metadata: { projectVersionId: versionId },
      });
    });
  }

  async listFacts(versionIdInput: string) {
    const versionId = await this.requireVersionId(versionIdInput);
    const items = await this.prisma.trainingFact.findMany({
      where: { projectVersionId: versionId },
      orderBy: [{ topicCode: 'asc' }, { code: 'asc' }],
      include: {
        questionLinks: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return { items };
  }

  async createFact(
    versionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    this.assertOnlyFields(
      body,
      [
        'code',
        'topicCode',
        'statement',
        'acceptedAliases',
        'importance',
        'sourceDocumentId',
        'sourceLocator',
        'isApproved',
        'questionIds',
      ],
      true,
    );
    const { questionIds, ...data } = this.parseFactInput(body);
    let factId: string;

    try {
      factId = await this.prisma.$transaction(async (tx) => {
        const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
        this.assertDraftVersion(version);
        await this.ensureQuestionsBelongToVersion(tx, versionId, questionIds);
        await this.ensureSourceDocumentBelongsToVersion(tx, versionId, data.sourceDocumentId);
        const fact = await tx.trainingFact.create({
          data: {
            projectVersionId: versionId,
            ...data,
          },
          select: { id: true },
        });
        await this.replaceFactQuestionLinks(tx, fact.id, questionIds);
        await this.writeAudit(tx, {
          action: 'training.fact.create',
          actor,
          request,
          entityType: 'training_fact',
          entityId: fact.id,
          metadata: {
            projectVersionId: versionId,
            code: data.code,
            questionIds,
          },
        });
        return fact.id;
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Fact code already exists');
    }

    return this.getFact(versionId, factId!);
  }

  async updateFact(
    versionIdInput: string,
    factIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const factId = this.parseUuid(factIdInput, 'Training fact is invalid');
    this.assertOnlyFields(
      body,
      [
        'code',
        'topicCode',
        'statement',
        'acceptedAliases',
        'importance',
        'sourceDocumentId',
        'sourceLocator',
        'isApproved',
        'questionIds',
      ],
      true,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        const fact = await tx.trainingFact.findFirst({
          where: { id: factId, projectVersionId: versionId },
          include: {
            questionLinks: true,
          },
        });
        if (!fact) {
          throw new NotFoundException('Training fact not found');
        }
        const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
        this.assertDraftVersion(version);
        const { questionIds, ...data } = this.parseFactInput(
          body,
          fact,
          fact.questionLinks.map((link) => link.questionId),
        );
        await this.ensureQuestionsBelongToVersion(tx, versionId, questionIds);
        await this.ensureSourceDocumentBelongsToVersion(tx, versionId, data.sourceDocumentId);
        await tx.trainingFact.update({ where: { id: factId }, data });
        if (this.hasOwn(body, 'questionIds')) {
          await this.replaceFactQuestionLinks(tx, factId, questionIds);
        }
        await this.writeAudit(tx, {
          action: 'training.fact.update',
          actor,
          request,
          entityType: 'training_fact',
          entityId: factId,
          metadata: {
            projectVersionId: versionId,
            changedFields: Object.keys(body),
          },
        });
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Fact code already exists');
    }

    return this.getFact(versionId, factId);
  }

  async deleteFact(
    versionIdInput: string,
    factIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const factId = this.parseUuid(factIdInput, 'Training fact is invalid');

    await this.prisma.$transaction(async (tx) => {
      const fact = await tx.trainingFact.findFirst({
        where: { id: factId, projectVersionId: versionId },
        include: {
          _count: {
            select: { scoreComponents: true },
          },
        },
      });
      if (!fact) {
        throw new NotFoundException('Training fact not found');
      }
      const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
      this.assertDraftVersion(version);
      if (fact._count.scoreComponents > 0) {
        throw new ConflictException('Used training fact cannot be deleted');
      }

      await tx.trainingFact.delete({ where: { id: factId } });
      await this.writeAudit(tx, {
        action: 'training.fact.delete',
        actor,
        request,
        entityType: 'training_fact',
        entityId: factId,
        metadata: { projectVersionId: versionId },
      });
    });
  }

  async listCriteria(versionIdInput: string) {
    const versionId = await this.requireVersionId(versionIdInput);
    const items = await this.prisma.trainingEvaluationCriterion.findMany({
      where: { projectVersionId: versionId },
      orderBy: [{ questionType: 'asc' }, { sortOrder: 'asc' }],
    });

    return { items };
  }

  async createCriterion(
    versionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    this.assertOnlyFields(
      body,
      [
        'questionType',
        'code',
        'title',
        'maxPoints',
        'description',
        'anchors',
        'sortOrder',
      ],
      true,
    );
    const data = this.parseCriterionInput(body);
    let criterionId: string;

    try {
      criterionId = await this.prisma.$transaction(async (tx) => {
        const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
        this.assertDraftVersion(version);
        const criterion = await tx.trainingEvaluationCriterion.create({
          data: {
            projectVersionId: versionId,
            ...data,
          },
          select: { id: true },
        });
        await this.writeAudit(tx, {
          action: 'training.criterion.create',
          actor,
          request,
          entityType: 'training_evaluation_criterion',
          entityId: criterion.id,
          metadata: {
            projectVersionId: versionId,
            questionType: data.questionType,
            code: data.code,
          },
        });
        return criterion.id;
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Criterion code or position already exists');
    }

    return this.getCriterion(versionId, criterionId!);
  }

  async updateCriterion(
    versionIdInput: string,
    criterionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const criterionId = this.parseUuid(criterionIdInput, 'Training criterion is invalid');
    this.assertOnlyFields(
      body,
      [
        'questionType',
        'code',
        'title',
        'maxPoints',
        'description',
        'anchors',
        'sortOrder',
      ],
      true,
    );

    try {
      await this.prisma.$transaction(async (tx) => {
        const criterion = await tx.trainingEvaluationCriterion.findFirst({
          where: { id: criterionId, projectVersionId: versionId },
        });
        if (!criterion) {
          throw new NotFoundException('Training criterion not found');
        }
        const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
        this.assertDraftVersion(version);
        const data = this.parseCriterionInput(body, criterion);
        await tx.trainingEvaluationCriterion.update({ where: { id: criterionId }, data });
        await this.writeAudit(tx, {
          action: 'training.criterion.update',
          actor,
          request,
          entityType: 'training_evaluation_criterion',
          entityId: criterionId,
          metadata: {
            projectVersionId: versionId,
            changedFields: Object.keys(body),
          },
        });
      });
    } catch (error) {
      this.rethrowPrismaConflict(error, 'Criterion code or position already exists');
    }

    return this.getCriterion(versionId, criterionId);
  }

  async deleteCriterion(
    versionIdInput: string,
    criterionIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const criterionId = this.parseUuid(criterionIdInput, 'Training criterion is invalid');

    await this.prisma.$transaction(async (tx) => {
      const criterion = await tx.trainingEvaluationCriterion.findFirst({
        where: { id: criterionId, projectVersionId: versionId },
        include: {
          _count: {
            select: { scoreComponents: true },
          },
        },
      });
      if (!criterion) {
        throw new NotFoundException('Training criterion not found');
      }
      const version = await tx.trainingProjectVersion.findUnique({ where: { id: versionId } });
      this.assertDraftVersion(version);
      if (criterion._count.scoreComponents > 0) {
        throw new ConflictException('Used training criterion cannot be deleted');
      }

      await tx.trainingEvaluationCriterion.delete({ where: { id: criterionId } });
      await this.writeAudit(tx, {
        action: 'training.criterion.delete',
        actor,
        request,
        entityType: 'training_evaluation_criterion',
        entityId: criterionId,
        metadata: { projectVersionId: versionId },
      });
    });
  }

  async publishVersion(
    id: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const versionId = this.parseUuid(id, 'Training version is invalid');
    let projectId: string;

    try {
      projectId = await this.prisma.$transaction(async (tx) => {
        const identity = await tx.trainingProjectVersion.findUnique({
          where: { id: versionId },
          select: { projectId: true },
        });
        if (!identity) {
          throw new NotFoundException('Training version not found');
        }

        await tx.$queryRaw`SELECT "id" FROM "training_projects" WHERE "id" = ${identity.projectId}::uuid FOR UPDATE`;
        const version = await tx.trainingProjectVersion.findUnique({
          where: { id: versionId },
          include: {
            project: true,
            questions: true,
            facts: true,
            criteria: true,
          },
        });
        this.assertDraftVersion(version);
        assertTrainingVersionPublishable({
          ...version!,
          warningSecondsJson: version!.warningSecondsJson,
          criteria: version!.criteria.map((criterion) => ({
            ...criterion,
            maxPoints: criterion.maxPoints,
          })),
        });

        const previousActiveVersionId = version!.project.activeVersionId;
        if (previousActiveVersionId && previousActiveVersionId !== versionId) {
          const previous = await tx.trainingProjectVersion.findUnique({
            where: { id: previousActiveVersionId },
            select: { status: true },
          });
          if (previous?.status === TrainingVersionStatus.PUBLISHED) {
            await tx.trainingProjectVersion.update({
              where: { id: previousActiveVersionId },
              data: { status: TrainingVersionStatus.SUPERSEDED },
            });
          }
        }

        const publishedAt = new Date();
        await tx.trainingProjectVersion.update({
          where: { id: versionId },
          data: {
            status: TrainingVersionStatus.PUBLISHED,
            publishedById: actor.id,
            publishedAt,
          },
        });
        await tx.trainingProject.update({
          where: { id: identity.projectId },
          data: {
            activeVersionId: versionId,
            status:
              version!.project.status === TrainingProjectStatus.DRAFT
                ? TrainingProjectStatus.CLOSED
                : version!.project.status,
          },
        });
        await this.writeAudit(tx, {
          action: 'training.version.publish',
          actor,
          request,
          entityType: 'training_project_version',
          entityId: versionId,
          metadata: {
            projectId: identity.projectId,
            versionNumber: version!.versionNumber,
            previousActiveVersionId,
            publishedAt: publishedAt.toISOString(),
          },
        });

        return identity.projectId;
      });
    } catch (error) {
      if (error instanceof UnprocessableEntityException) {
        throw error;
      }
      this.rethrowPrismaConflict(error, 'Training version publication conflicted with another update');
    }

    return this.getProject(projectId!);
  }

  async openProject(
    id: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    return this.changeProjectLifecycle(
      id,
      TrainingProjectStatus.OPEN,
      'training.project.open',
      actor,
      request,
    );
  }

  async closeProject(
    id: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    return this.changeProjectLifecycle(
      id,
      TrainingProjectStatus.CLOSED,
      'training.project.close',
      actor,
      request,
    );
  }

  async archiveProject(
    id: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    return this.changeProjectLifecycle(
      id,
      TrainingProjectStatus.ARCHIVED,
      'training.project.archive',
      actor,
      request,
    );
  }

  private async changeProjectLifecycle(
    id: string,
    status: TrainingProjectStatus,
    action: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const projectId = this.parseUuid(id, 'Training project is invalid');

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "training_projects" WHERE "id" = ${projectId}::uuid FOR UPDATE`;
      const project = await tx.trainingProject.findUnique({
        where: { id: projectId },
        include: {
          activeVersion: {
            select: { id: true, status: true },
          },
        },
      });
      if (!project) {
        throw new NotFoundException('Training project not found');
      }
      if (project.status === TrainingProjectStatus.ARCHIVED) {
        throw new ConflictException('Archived training project is immutable');
      }
      if (status === TrainingProjectStatus.OPEN) {
        if (
          !project.activeVersion ||
          project.activeVersion.status !== TrainingVersionStatus.PUBLISHED
        ) {
          throw new ConflictException('Only a project with an active published version can be opened');
        }
        assertTrainingAvailability(project.availableFrom, project.deadlineAt);
        if (project.deadlineAt && project.deadlineAt.getTime() <= Date.now()) {
          throw new UnprocessableEntityException('Training project deadline has already passed');
        }
      }

      await tx.trainingProject.update({
        where: { id: projectId },
        data: {
          status,
          archivedAt: status === TrainingProjectStatus.ARCHIVED ? new Date() : null,
        },
      });
      await this.writeAudit(tx, {
        action,
        actor,
        request,
        entityType: 'training_project',
        entityId: projectId,
        metadata: {
          fromStatus: project.status,
          toStatus: status,
          activeVersionId: project.activeVersionId,
        },
      });
    });

    return this.getProject(projectId);
  }

  private async getQuestion(versionId: string, questionId: string) {
    const question = await this.prisma.trainingQuestion.findFirst({
      where: { id: questionId, projectVersionId: versionId },
      include: {
        factLinks: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!question) {
      throw new NotFoundException('Training question not found');
    }
    return { question };
  }

  private async getFact(versionId: string, factId: string) {
    const fact = await this.prisma.trainingFact.findFirst({
      where: { id: factId, projectVersionId: versionId },
      include: {
        questionLinks: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!fact) {
      throw new NotFoundException('Training fact not found');
    }
    return { fact };
  }

  private async getCriterion(versionId: string, criterionId: string) {
    const criterion = await this.prisma.trainingEvaluationCriterion.findFirst({
      where: { id: criterionId, projectVersionId: versionId },
    });
    if (!criterion) {
      throw new NotFoundException('Training criterion not found');
    }
    return { criterion };
  }

  private async requireVersionId(id: string) {
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

  private assertDraftVersion(
    version:
      | {
          status: TrainingVersionStatus;
        }
      | null,
  ): asserts version is { status: TrainingVersionStatus } {
    if (!version) {
      throw new NotFoundException('Training version not found');
    }
    if (version.status !== TrainingVersionStatus.DRAFT) {
      throw new ConflictException('Published training version is immutable; create a new draft');
    }
  }

  private parseQuestionInput(
    body: Record<string, unknown>,
    current?: {
      type: TrainingQuestionType;
      text: string;
      position: number;
      isActive: boolean;
      maxScore: number;
      topicCodesJson: Prisma.JsonValue;
    },
  ) {
    const type = this.hasOwn(body, 'type')
      ? this.parseQuestionType(body.type)
      : current?.type;
    if (!type) {
      throw new BadRequestException('Question type is required');
    }
    const text = this.hasOwn(body, 'text')
      ? this.parseRequiredString(body.text, 'Question text is required', 4000)
      : current?.text;
    if (!text) {
      throw new BadRequestException('Question text is required');
    }
    const position = this.hasOwn(body, 'position')
      ? this.parsePositiveInteger(body.position, 'Question position')
      : current?.position;
    if (!position) {
      throw new BadRequestException('Question position is required');
    }
    if (type === TrainingQuestionType.MAIN && position !== 1) {
      throw new BadRequestException('Main question position must equal 1');
    }
    if (type === TrainingQuestionType.FOLLOW_UP && (position < 1 || position > 10)) {
      throw new BadRequestException('Follow-up question position must be between 1 and 10');
    }

    const expectedMaxScore =
      type === TrainingQuestionType.MAIN
        ? TRAINING_MAIN_MAX_SCORE
        : TRAINING_FOLLOW_UP_MAX_SCORE;
    if (this.hasOwn(body, 'maxScore')) {
      const maxScore = this.parseNonNegativeInteger(body.maxScore, 'Question maximum score');
      if (maxScore !== expectedMaxScore) {
        throw new BadRequestException(
          `${type === TrainingQuestionType.MAIN ? 'Main' : 'Follow-up'} question maximum must equal ${expectedMaxScore}`,
        );
      }
    }

    return {
      type,
      text,
      position,
      isActive: this.hasOwn(body, 'isActive')
        ? this.parseBoolean(body.isActive, 'Question active flag')
        : (current?.isActive ?? true),
      maxScore: expectedMaxScore,
      topicCodesJson: this.hasOwn(body, 'topicCodes')
        ? this.parseUniqueStringArray(body.topicCodes, 50, 120, 'Topic codes')
        : this.toInputJson(current?.topicCodesJson ?? []),
    };
  }

  private parseFactInput(
    body: Record<string, unknown>,
    current?: {
      code: string;
      topicCode: string;
      statement: string;
      acceptedAliasesJson: Prisma.JsonValue;
      importance: number;
      sourceDocumentId: string | null;
      sourceLocatorJson: Prisma.JsonValue | null;
      isApproved: boolean;
    },
    currentQuestionIds: string[] = [],
  ) {
    const code = this.hasOwn(body, 'code')
      ? this.parseCode(body.code, 'Fact code')
      : current?.code;
    const topicCode = this.hasOwn(body, 'topicCode')
      ? this.parseCode(body.topicCode, 'Fact topic code')
      : current?.topicCode;
    const statement = this.hasOwn(body, 'statement')
      ? this.parseRequiredString(body.statement, 'Fact statement is required', 8000)
      : current?.statement;
    if (!code || !topicCode || !statement) {
      throw new BadRequestException('Fact code, topic code and statement are required');
    }

    return {
      code,
      topicCode,
      statement,
      acceptedAliasesJson: this.hasOwn(body, 'acceptedAliases')
        ? this.parseUniqueStringArray(body.acceptedAliases, 100, 500, 'Accepted aliases')
        : this.toInputJson(current?.acceptedAliasesJson ?? []),
      importance: this.hasOwn(body, 'importance')
        ? this.parsePositiveInteger(body.importance, 'Fact importance')
        : (current?.importance ?? 1),
      sourceDocumentId: this.hasOwn(body, 'sourceDocumentId')
        ? this.parseNullableUuid(body.sourceDocumentId, 'Source document is invalid')
        : (current?.sourceDocumentId ?? null),
      sourceLocatorJson: this.hasOwn(body, 'sourceLocator')
        ? this.parseNullableJsonObject(body.sourceLocator, 'Source locator is invalid')
        : this.toNullableInputJson(current?.sourceLocatorJson ?? null),
      isApproved: this.hasOwn(body, 'isApproved')
        ? this.parseBoolean(body.isApproved, 'Fact approval flag')
        : (current?.isApproved ?? false),
      questionIds: this.hasOwn(body, 'questionIds')
        ? this.parseUuidArray(body.questionIds, 11, 'Question IDs')
        : currentQuestionIds,
    };
  }

  private parseCriterionInput(
    body: Record<string, unknown>,
    current?: {
      questionType: TrainingQuestionType;
      code: string;
      title: string;
      maxPoints: Prisma.Decimal;
      description: string | null;
      anchorsJson: Prisma.JsonValue;
      sortOrder: number;
    },
  ) {
    const questionType = this.hasOwn(body, 'questionType')
      ? this.parseQuestionType(body.questionType)
      : current?.questionType;
    const code = this.hasOwn(body, 'code')
      ? this.parseCode(body.code, 'Criterion code')
      : current?.code;
    const title = this.hasOwn(body, 'title')
      ? this.parseRequiredString(body.title, 'Criterion title is required', 240)
      : current?.title;
    if (!questionType || !code || !title) {
      throw new BadRequestException('Criterion question type, code and title are required');
    }

    const maximum =
      questionType === TrainingQuestionType.MAIN
        ? TRAINING_MAIN_MAX_SCORE
        : TRAINING_FOLLOW_UP_MAX_SCORE;
    const maxPoints = this.hasOwn(body, 'maxPoints')
      ? this.parseDecimal(body.maxPoints, 'Criterion maximum points', maximum)
      : current?.maxPoints;
    if (maxPoints === undefined) {
      throw new BadRequestException('Criterion maximum points are required');
    }

    return {
      questionType,
      code,
      title,
      maxPoints,
      description: this.hasOwn(body, 'description')
        ? this.parseNullableString(body.description, 'Criterion description', 4000)
        : (current?.description ?? null),
      anchorsJson: this.hasOwn(body, 'anchors')
        ? this.parseJsonArray(body.anchors, 100, 'Criterion anchors are invalid')
        : this.toInputJson(current?.anchorsJson ?? []),
      sortOrder: this.hasOwn(body, 'sortOrder')
        ? this.parseNonNegativeInteger(body.sortOrder, 'Criterion sort order')
        : (current?.sortOrder ?? 0),
    };
  }

  private parseVersionSettings(
    body: Record<string, unknown>,
    current?: VersionSettings,
  ): VersionSettings {
    const passScore = this.hasOwn(body, 'passScore')
      ? this.parseIntegerInRange(body.passScore, 'Pass score', 0, 100)
      : (current?.passScore ?? 75);
    const attemptLimit = this.hasOwn(body, 'attemptLimit')
      ? this.parsePositiveInteger(body.attemptLimit, 'Attempt limit')
      : (current?.attemptLimit ?? 3);
    const cooldownMinutes = this.hasOwn(body, 'cooldownMinutes')
      ? this.parseIntegerInRange(body.cooldownMinutes, 'Cooldown', 60, 1440)
      : (current?.cooldownMinutes ?? 60);
    const totalTimeLimitSeconds = this.hasOwn(body, 'totalTimeLimitSeconds')
      ? this.parseIntegerInRange(body.totalTimeLimitSeconds, 'Attempt timer', 300, 420)
      : (current?.totalTimeLimitSeconds ?? 420);
    const finishGraceSeconds = this.hasOwn(body, 'finishGraceSeconds')
      ? this.parseNonNegativeInteger(body.finishGraceSeconds, 'Finish grace')
      : (current?.finishGraceSeconds ?? 90);
    const warningSeconds = this.hasOwn(body, 'warningSeconds')
      ? this.parseWarningSeconds(body.warningSeconds, totalTimeLimitSeconds)
      : this.parseWarningSeconds(current?.warningSecondsJson ?? [60, 20], totalTimeLimitSeconds);

    return {
      passScore,
      attemptLimit,
      cooldownMinutes,
      totalTimeLimitSeconds,
      finishGraceSeconds,
      warningSecondsJson: warningSeconds,
      allowRetakeAfterPass: this.hasOwn(body, 'allowRetakeAfterPass')
        ? this.parseBoolean(body.allowRetakeAfterPass, 'Retake after pass flag')
        : (current?.allowRetakeAfterPass ?? false),
      mainMaxScore: TRAINING_MAIN_MAX_SCORE,
      followUpMaxScore: TRAINING_FOLLOW_UP_MAX_SCORE,
      scoringConfigJson: this.hasOwn(body, 'scoringConfig')
        ? this.parseJsonObject(body.scoringConfig, 'Scoring config is invalid')
        : (current?.scoringConfigJson ?? {}),
      promptVersion: this.hasOwn(body, 'promptVersion')
        ? this.parseRequiredString(body.promptVersion, 'Prompt version is required', 64)
        : (current?.promptVersion ?? '1'),
      schemaVersion: this.hasOwn(body, 'schemaVersion')
        ? this.parseRequiredString(body.schemaVersion, 'Schema version is required', 64)
        : (current?.schemaVersion ?? '1'),
    };
  }

  private copyVersionSettings(version: {
    passScore: number;
    attemptLimit: number;
    cooldownMinutes: number;
    totalTimeLimitSeconds: number;
    finishGraceSeconds: number;
    warningSecondsJson: Prisma.JsonValue | Prisma.InputJsonValue;
    allowRetakeAfterPass: boolean;
    mainMaxScore: number;
    followUpMaxScore: number;
    scoringConfigJson: Prisma.JsonValue | Prisma.InputJsonValue;
    promptVersion: string;
    schemaVersion: string;
  }): VersionSettings {
    return {
      passScore: version.passScore,
      attemptLimit: version.attemptLimit,
      cooldownMinutes: version.cooldownMinutes,
      totalTimeLimitSeconds: version.totalTimeLimitSeconds,
      finishGraceSeconds: version.finishGraceSeconds,
      warningSecondsJson: this.toInputJson(version.warningSecondsJson),
      allowRetakeAfterPass: version.allowRetakeAfterPass,
      mainMaxScore: version.mainMaxScore,
      followUpMaxScore: version.followUpMaxScore,
      scoringConfigJson: this.toInputJson(version.scoringConfigJson),
      promptVersion: version.promptVersion,
      schemaVersion: version.schemaVersion,
    };
  }

  private async cloneVersionContent(
    tx: TrainingTransaction,
    source: TrainingVersionContentRecord,
    targetVersionId: string,
  ) {
    const documentIds = new Map<string, string>();
    for (const document of source.sourceDocuments) {
      const cloned = await tx.trainingSourceDocument.create({
        data: {
          projectVersionId: targetVersionId,
          fileId: document.fileId,
          documentType: document.documentType,
          checksum: document.checksum,
          extractionStatus: document.extractionStatus,
          extractedText: document.extractedText,
          extractionMetadataJson: this.toInputJson(document.extractionMetadataJson),
          errorMessage: document.errorMessage,
        },
        select: { id: true },
      });
      documentIds.set(document.id, cloned.id);
    }

    const questionIds = new Map<string, string>();
    for (const question of source.questions) {
      const cloned = await tx.trainingQuestion.create({
        data: {
          projectVersionId: targetVersionId,
          type: question.type,
          text: question.text,
          position: question.position,
          isActive: question.isActive,
          maxScore: question.maxScore,
          topicCodesJson: this.toInputJson(question.topicCodesJson),
        },
        select: { id: true },
      });
      questionIds.set(question.id, cloned.id);
    }

    const factIds = new Map<string, string>();
    for (const fact of source.facts) {
      const cloned = await tx.trainingFact.create({
        data: {
          projectVersionId: targetVersionId,
          code: fact.code,
          topicCode: fact.topicCode,
          statement: fact.statement,
          acceptedAliasesJson: this.toInputJson(fact.acceptedAliasesJson),
          importance: fact.importance,
          sourceDocumentId: fact.sourceDocumentId
            ? (documentIds.get(fact.sourceDocumentId) ?? null)
            : null,
          sourceLocatorJson: this.toNullableInputJson(fact.sourceLocatorJson),
          isApproved: fact.isApproved,
        },
        select: { id: true },
      });
      factIds.set(fact.id, cloned.id);
    }

    for (const criterion of source.criteria) {
      await tx.trainingEvaluationCriterion.create({
        data: {
          projectVersionId: targetVersionId,
          questionType: criterion.questionType,
          code: criterion.code,
          title: criterion.title,
          maxPoints: criterion.maxPoints,
          description: criterion.description,
          anchorsJson: this.toInputJson(criterion.anchorsJson),
          sortOrder: criterion.sortOrder,
        },
      });
    }

    for (const question of source.questions) {
      for (const link of question.factLinks) {
        const questionId = questionIds.get(link.questionId);
        const factId = factIds.get(link.factId);
        if (questionId && factId) {
          await tx.trainingQuestionFactLink.create({
            data: {
              questionId,
              factId,
              weight: link.weight,
              isRequired: link.isRequired,
            },
          });
        }
      }
    }
  }

  private async ensureQuestionsBelongToVersion(
    tx: TrainingTransaction,
    versionId: string,
    questionIds: string[],
  ) {
    if (questionIds.length === 0) {
      return;
    }
    const count = await tx.trainingQuestion.count({
      where: {
        id: { in: questionIds },
        projectVersionId: versionId,
      },
    });
    if (count !== questionIds.length) {
      throw new BadRequestException('Every linked question must belong to the fact version');
    }
  }

  private async ensureSourceDocumentBelongsToVersion(
    tx: TrainingTransaction,
    versionId: string,
    sourceDocumentId: string | null,
  ) {
    if (sourceDocumentId === null) {
      return;
    }
    const document = await tx.trainingSourceDocument.findFirst({
      where: {
        id: sourceDocumentId,
        projectVersionId: versionId,
      },
      select: { id: true },
    });
    if (!document) {
      throw new BadRequestException('Source document must belong to the fact version');
    }
  }

  private async replaceFactQuestionLinks(
    tx: TrainingTransaction,
    factId: string,
    questionIds: string[],
  ) {
    await tx.trainingQuestionFactLink.deleteMany({ where: { factId } });
    for (const questionId of questionIds) {
      await tx.trainingQuestionFactLink.create({
        data: {
          factId,
          questionId,
        },
      });
    }
  }

  private async ensureRealEstateObjectExists(id: string | null) {
    if (id === null) {
      return;
    }
    const object = await this.prisma.realEstateObject.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!object) {
      throw new BadRequestException('Real estate object not found');
    }
  }

  private async writeAudit(
    tx: TrainingTransaction,
    params: {
      action: string;
      actor: AuthenticatedUser;
      request: TrainingAuditRequest;
      entityType: string;
      entityId: string;
      metadata: Prisma.InputJsonObject;
    },
  ) {
    await tx.auditLog.create({
      data: {
        actorUserId: params.actor.id,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        metadata: params.metadata,
        ipAddress: this.getRequestIp(params.request),
        userAgent: this.getHeader(params.request, 'user-agent'),
      },
    });
  }

  private parseSlug(value: unknown) {
    const slug = this.parseRequiredString(value, 'Slug is required', 160).toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      throw new BadRequestException('Slug must contain lowercase latin letters, digits and hyphens');
    }
    return slug;
  }

  private assertOnlyVersionSettingFields(
    body: Record<string, unknown>,
    requireOne: boolean,
  ) {
    this.assertOnlyFields(
      body,
      [
        'passScore',
        'attemptLimit',
        'cooldownMinutes',
        'totalTimeLimitSeconds',
        'finishGraceSeconds',
        'warningSeconds',
        'allowRetakeAfterPass',
        'scoringConfig',
        'promptVersion',
        'schemaVersion',
      ],
      requireOne,
    );
  }

  private assertOnlyFields(
    body: Record<string, unknown>,
    allowedFields: string[],
    requireOne = false,
  ) {
    const fields = Object.keys(body);
    const unsupported = fields.filter((field) => !allowedFields.includes(field));
    if (unsupported.length > 0) {
      throw new BadRequestException(`Unsupported fields: ${unsupported.join(', ')}`);
    }
    if (requireOne && fields.length === 0) {
      throw new BadRequestException('At least one field is required');
    }
  }

  private parseCode(value: unknown, label: string) {
    const code = this.parseRequiredString(value, `${label} is required`, 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(code)) {
      throw new BadRequestException(`${label} contains unsupported characters`);
    }
    return code;
  }

  private parseProjectStatus(value: unknown, label: string) {
    if (
      typeof value !== 'string' ||
      !Object.values(TrainingProjectStatus).includes(value.toUpperCase() as TrainingProjectStatus)
    ) {
      throw new BadRequestException(`${label} is invalid`);
    }
    return value.toUpperCase() as TrainingProjectStatus;
  }

  private parseQuestionType(value: unknown) {
    if (
      typeof value !== 'string' ||
      !Object.values(TrainingQuestionType).includes(value.toUpperCase() as TrainingQuestionType)
    ) {
      throw new BadRequestException('Question type is invalid');
    }
    return value.toUpperCase() as TrainingQuestionType;
  }

  private parseWarningSeconds(value: unknown, totalTimeLimitSeconds: number) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
      throw new BadRequestException('Warning seconds are invalid');
    }
    const warnings = value.map((item) =>
      this.parsePositiveInteger(item, 'Warning second'),
    );
    if (new Set(warnings).size !== warnings.length) {
      throw new BadRequestException('Warning seconds must be unique');
    }
    if (warnings.some((warning) => warning >= totalTimeLimitSeconds)) {
      throw new BadRequestException('Warning seconds must be below the attempt timer');
    }
    if (warnings.some((warning, index) => index > 0 && warnings[index - 1]! <= warning)) {
      throw new BadRequestException('Warning seconds must be ordered from largest to smallest');
    }
    return warnings;
  }

  private parseDecimal(value: unknown, label: string, maximum: number) {
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      value === '' ||
      !/^\d+(?:\.\d{1,2})?$/u.test(String(value))
    ) {
      throw new BadRequestException(`${label} is invalid`);
    }
    const decimal = new Prisma.Decimal(String(value));
    if (decimal.isNegative() || decimal.greaterThan(maximum)) {
      throw new BadRequestException(`${label} must be between 0 and ${maximum}`);
    }
    return decimal;
  }

  private parseObject(value: unknown, message: string) {
    if (!this.isRecord(value)) {
      throw new BadRequestException(message);
    }
    return value;
  }

  private parseJsonObject(value: unknown, message: string): Prisma.InputJsonObject {
    if (!this.isRecord(value)) {
      throw new BadRequestException(message);
    }
    return value as Prisma.InputJsonObject;
  }

  private parseNullableJsonObject(
    value: unknown,
    message: string,
  ): Prisma.InputJsonObject | typeof Prisma.JsonNull {
    if (value === null || value === undefined) {
      return Prisma.JsonNull;
    }
    return this.parseJsonObject(value, message);
  }

  private parseJsonArray(value: unknown, maxItems: number, message: string) {
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new BadRequestException(message);
    }
    return value as Prisma.InputJsonArray;
  }

  private parseRequiredString(value: unknown, message: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(message);
    }
    const text = value.trim();
    if (text.length > maxLength) {
      throw new BadRequestException(`${message}: too long`);
    }
    return text;
  }

  private parseNullableString(value: unknown, label: string, maxLength: number) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label} is invalid`);
    }
    const text = value.trim();
    if (text.length > maxLength) {
      throw new BadRequestException(`${label} is too long`);
    }
    return text || null;
  }

  private parseOptionalQueryString(value: unknown, label: string, maxLength: number) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label} is invalid`);
    }
    const text = value.trim();
    if (text.length > maxLength) {
      throw new BadRequestException(`${label} is too long`);
    }
    return text || null;
  }

  private parseNullableDate(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw new BadRequestException(`${label} is invalid`);
    }
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new BadRequestException(`${label} is invalid`);
    }
    return date;
  }

  private parseBoolean(value: unknown, label: string) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${label} is invalid`);
    }
    return value;
  }

  private parsePositiveInteger(
    value: unknown,
    label: string,
    fallback?: number,
    maximum?: number,
  ) {
    if ((value === undefined || value === null || value === '') && fallback !== undefined) {
      return fallback;
    }
    const parsed = this.parseInteger(value, label);
    if (parsed < 1 || (maximum !== undefined && parsed > maximum)) {
      throw new BadRequestException(
        maximum ? `${label} must be between 1 and ${maximum}` : `${label} must be positive`,
      );
    }
    return parsed;
  }

  private parseNonNegativeInteger(value: unknown, label: string, fallback?: number) {
    if ((value === undefined || value === null || value === '') && fallback !== undefined) {
      return fallback;
    }
    const parsed = this.parseInteger(value, label);
    if (parsed < 0) {
      throw new BadRequestException(`${label} must be non-negative`);
    }
    return parsed;
  }

  private parseIntegerInRange(
    value: unknown,
    label: string,
    minimum: number,
    maximum: number,
  ) {
    const parsed = this.parseInteger(value, label);
    if (parsed < minimum || parsed > maximum) {
      throw new BadRequestException(`${label} must be between ${minimum} and ${maximum}`);
    }
    return parsed;
  }

  private parseInteger(value: unknown, label: string) {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException(`${label} must be an integer`);
    }
    return parsed;
  }

  private parseNullableUuid(value: unknown, message: string) {
    if (value === undefined || value === null || value === '') {
      return null;
    }
    return this.parseUuid(this.parseRequiredString(value, message, 64), message);
  }

  private parseUuidArray(value: unknown, maxItems: number, label: string) {
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new BadRequestException(`${label} are invalid`);
    }
    const items = value.map((item) =>
      this.parseUuid(this.parseRequiredString(item, `${label} item is invalid`, 64), `${label} item is invalid`),
    );
    if (new Set(items).size !== items.length) {
      throw new BadRequestException(`${label} must be unique`);
    }
    return items;
  }

  private parseUniqueStringArray(
    value: unknown,
    maxItems: number,
    maxLength: number,
    label: string,
  ) {
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new BadRequestException(`${label} are invalid`);
    }
    const items = value.map((item) =>
      this.parseRequiredString(item, `${label} item is invalid`, maxLength),
    );
    if (
      new Set(items.map((item) => normalizeTrainingUniqueKey(item))).size !== items.length
    ) {
      throw new BadRequestException(`${label} must be unique`);
    }
    return items;
  }

  private parseUuid(value: string, message: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
      throw new BadRequestException(message);
    }
    return value;
  }

  private toInputJson(value: Prisma.JsonValue | Prisma.InputJsonValue): Prisma.InputJsonValue {
    return value as Prisma.InputJsonValue;
  }

  private toNullableInputJson(
    value: Prisma.JsonValue | Prisma.InputJsonValue | null,
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
  }

  private hasOwn(value: Record<string, unknown>, key: string) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private rethrowPrismaConflict(error: unknown, message: string): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    ) {
      throw new ConflictException(message);
    }
    throw error;
  }

  private getRequestIp(request: TrainingAuditRequest) {
    const forwardedFor = this.getHeader(request, 'x-forwarded-for');
    return forwardedFor?.split(',')[0]?.trim() || request.ip || request.socket?.remoteAddress || null;
  }

  private getHeader(request: TrainingAuditRequest, name: string) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}

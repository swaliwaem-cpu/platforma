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
import { TRAINING_SNAPSHOT_FOLLOW_UP_COUNT } from './training-snapshot';

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

export type UpdateTrainingProjectDraftInput = CreateTrainingProjectInput & {
  mainQuestion: string;
  followUpQuestions: string[];
};

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
      include: {
        questions: true,
      },
    });

    if (!project) {
      throw new NotFoundException('Training project not found');
    }

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
      mainQuestion: mainQuestion?.text ?? '',
      followUpQuestions: followUpQuestions.map((question) => question.text),
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    };
  }

  async createProject(input: CreateTrainingProjectInput) {
    await this.ensureRealEstateObjectExists(input.realEstateObjectId);

    const project = await this.prisma.trainingProject.create({
      data: input,
      select: { id: true },
    });

    return this.getAdminProject(project.id);
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
        },
      });

      await this.upsertQuestion(
        transaction,
        projectId,
        TrainingQuestionType.MAIN,
        1,
        input.mainQuestion,
      );

      for (const [index, text] of input.followUpQuestions.entries()) {
        await this.upsertQuestion(
          transaction,
          projectId,
          TrainingQuestionType.FOLLOW_UP,
          index + 1,
          text,
        );
      }
    });

    return this.getAdminProject(projectId);
  }

  async publishProject(projectId: string) {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockProject(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        include: { questions: true },
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
        select: { id: true, status: true },
      });

      if (!project) {
        throw new NotFoundException('Training project not found');
      }

      if (isOpen && project.status !== TrainingProjectStatus.PUBLISHED) {
        throw new ConflictException('Only a published training project can be opened');
      }

      await transaction.trainingProject.update({
        where: { id: projectId },
        data: { isOpen },
      });
    });

    return this.getAdminProject(projectId);
  }

  validatePublication(project: {
    title: string;
    attemptLimit: number;
    timeLimitSeconds: number;
    passScore: number;
    questions: Array<{ type: TrainingQuestionType; isActive: boolean; text: string }>;
  }) {
    const activeQuestions = project.questions.filter((question) => question.isActive);
    const mainQuestions = activeQuestions.filter(
      (question) => question.type === TrainingQuestionType.MAIN && question.text.trim(),
    );
    const followUpQuestions = activeQuestions.filter(
      (question) => question.type === TrainingQuestionType.FOLLOW_UP && question.text.trim(),
    );

    if (!project.title.trim()) {
      throw new BadRequestException('Training project title is required');
    }

    if (project.attemptLimit < 1 || project.timeLimitSeconds < 1) {
      throw new BadRequestException('Training attempt and time limits must be positive');
    }

    if (project.passScore < 0 || project.passScore > 100) {
      throw new BadRequestException('Training pass score must be between 0 and 100');
    }

    if (
      mainQuestions.length !== 1 ||
      followUpQuestions.length !== TRAINING_SNAPSHOT_FOLLOW_UP_COUNT
    ) {
      throw new BadRequestException(
        `Publishing requires 1 main and ${TRAINING_SNAPSHOT_FOLLOW_UP_COUNT} follow-up questions`,
      );
    }
  }

  private async upsertQuestion(
    transaction: Prisma.TransactionClient,
    projectId: string,
    type: TrainingQuestionType,
    position: number,
    text: string,
  ) {
    await transaction.trainingQuestion.upsert({
      where: {
        projectId_type_position: { projectId, type, position },
      },
      update: { text, isActive: true },
      create: { projectId, type, position, text, isActive: true },
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
    if (!realEstateObjectId) {
      return;
    }

    const object = await client.realEstateObject.findUnique({
      where: { id: realEstateObjectId },
      select: { id: true },
    });

    if (!object) {
      throw new BadRequestException('Real estate object not found');
    }
  }
}

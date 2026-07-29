import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingProjectAudienceMode,
  TrainingProjectStatus,
  UserStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { TrainingAuditRequest } from './training-content.service';
import {
  acquireTrainingProjectAudienceLock,
  acquireTrainingUserProjectLock,
} from './training-project-access';

const TRAINING_TAKE_PERMISSION = 'training:take';
const SERIALIZABLE_RETRY_LIMIT = 3;
const MAX_ASSIGNMENTS_PER_PROJECT = 500;

@Injectable()
export class TrainingAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listCandidates(query: Record<string, unknown>) {
    const page = readInteger(query.page, 'page', 1, 1, 10_000);
    const limit = readInteger(query.limit, 'limit', 20, 1, 100);
    const search = readOptionalString(query.search, 'search', 200);
    const where: Prisma.UserWhereInput = {
      status: UserStatus.ACTIVE,
      deletedAt: null,
      role: {
        permissions: {
          some: {
            permission: {
              key: TRAINING_TAKE_PERMISSION,
            },
          },
        },
      },
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ name: 'asc' }, { email: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          trainingTelegramAccount: {
            select: {
              revokedAt: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        status: user.status,
        eligible: true,
        telegramConnected:
          user.trainingTelegramAccount?.revokedAt === null,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getAssignments(projectIdInput: string) {
    const projectId = readUuid(projectIdInput, 'projectId');
    const result = await this.readAssignmentSummary(this.prisma, projectId);
    if (!result) {
      throw new NotFoundException('Training project not found');
    }
    return result;
  }

  async updateAudience(
    projectIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const projectId = readUuid(projectIdInput, 'projectId');
    assertOnlyFields(body, ['audienceMode', 'expectedRevision']);
    const audienceMode = readAudienceMode(body.audienceMode);
    const expectedRevision = readInteger(
      body.expectedRevision,
      'expectedRevision',
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    return this.runSerializable(async (tx) => {
      await acquireTrainingProjectAudienceLock(tx, projectId);
      const project = await tx.trainingProject.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          status: true,
          audienceMode: true,
          audienceRevision: true,
        },
      });
      assertMutableProject(project);

      if (project!.audienceMode === audienceMode) {
        return (await this.readAssignmentSummary(tx, projectId))!;
      }
      assertExpectedRevision(project!.audienceRevision, expectedRevision);
      if (
        audienceMode === TrainingProjectAudienceMode.ASSIGNED_ONLY &&
        project!.status === TrainingProjectStatus.OPEN
      ) {
        const eligibleAssignmentCount =
          await tx.trainingProjectAssignment.count({
            where: {
              projectId,
              revokedAt: null,
              user: eligibleTrainingUserWhere(),
            },
          });
        if (eligibleAssignmentCount === 0) {
          throw new UnprocessableEntityException(
            'Open assigned-only training project requires at least one eligible assignee',
          );
        }
      }

      await tx.trainingProject.update({
        where: { id: projectId },
        data: {
          audienceMode,
          audienceRevision: { increment: 1 },
        },
      });
      await this.writeAudit(tx, {
        action: 'training.project.audience.update',
        actor,
        request,
        projectId,
        metadata: {
          fromAudienceMode: project!.audienceMode,
          toAudienceMode: audienceMode,
          fromRevision: project!.audienceRevision,
          toRevision: project!.audienceRevision + 1,
        },
      });
      return (await this.readAssignmentSummary(tx, projectId))!;
    });
  }

  async replaceAssignments(
    projectIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const projectId = readUuid(projectIdInput, 'projectId');
    assertOnlyFields(body, ['userIds', 'expectedRevision']);
    const userIds = readUuidArray(body.userIds, 'userIds');
    const expectedRevision = readInteger(
      body.expectedRevision,
      'expectedRevision',
      undefined,
      0,
      Number.MAX_SAFE_INTEGER,
    );

    return this.runSerializable(async (tx) => {
      await acquireTrainingProjectAudienceLock(tx, projectId);
      const project = await tx.trainingProject.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          status: true,
          audienceMode: true,
          audienceRevision: true,
          assignments: {
            where: { revokedAt: null },
            select: { userId: true },
          },
        },
      });
      assertMutableProject(project);

      const currentUserIds = project!.assignments
        .map((assignment) => assignment.userId)
        .sort();
      if (sameStringArray(currentUserIds, userIds)) {
        return (await this.readAssignmentSummary(tx, projectId))!;
      }
      assertExpectedRevision(project!.audienceRevision, expectedRevision);
      if (
        project!.status === TrainingProjectStatus.OPEN &&
        project!.audienceMode ===
          TrainingProjectAudienceMode.ASSIGNED_ONLY &&
        userIds.length === 0
      ) {
        throw new UnprocessableEntityException(
          'Open assigned-only training project requires at least one eligible assignee',
        );
      }

      for (const userId of [...new Set([...currentUserIds, ...userIds])].sort()) {
        await acquireTrainingUserProjectLock(tx, userId, projectId);
      }

      if (userIds.length > 0) {
        const eligibleUsers = await tx.user.findMany({
          where: {
            id: { in: userIds },
            ...eligibleTrainingUserWhere(),
          },
          select: { id: true },
        });
        if (eligibleUsers.length !== userIds.length) {
          throw new BadRequestException(
            'Every assignee must be an active user with training:take',
          );
        }
      }

      const targetUserIds = new Set(userIds);
      const currentUserIdSet = new Set(currentUserIds);
      const addedUserIds = userIds.filter(
        (userId) => !currentUserIdSet.has(userId),
      );
      const removedUserIds = currentUserIds.filter(
        (userId) => !targetUserIds.has(userId),
      );
      const changedAt = new Date();

      if (removedUserIds.length > 0) {
        await tx.trainingProjectAssignment.updateMany({
          where: {
            projectId,
            userId: { in: removedUserIds },
            revokedAt: null,
          },
          data: {
            revokedAt: changedAt,
            revokedById: actor.id,
          },
        });
      }
      if (addedUserIds.length > 0) {
        await tx.trainingProjectAssignment.updateMany({
          where: {
            projectId,
            userId: { in: addedUserIds },
            revokedAt: { not: null },
          },
          data: {
            assignedAt: changedAt,
            assignedById: actor.id,
            revokedAt: null,
            revokedById: null,
          },
        });
        await tx.trainingProjectAssignment.createMany({
          data: addedUserIds.map((userId) => ({
            projectId,
            userId,
            assignedById: actor.id,
            assignedAt: changedAt,
            createdAt: changedAt,
          })),
          skipDuplicates: true,
        });
      }

      await tx.trainingProject.update({
        where: { id: projectId },
        data: {
          audienceRevision: { increment: 1 },
        },
      });
      await this.writeAudit(tx, {
        action: 'training.project.assignments.replace',
        actor,
        request,
        projectId,
        metadata: {
          addedUserIds,
          removedUserIds,
          activeAssignmentCount: userIds.length,
          fromRevision: project!.audienceRevision,
          toRevision: project!.audienceRevision + 1,
        },
      });
      return (await this.readAssignmentSummary(tx, projectId))!;
    });
  }

  private async readAssignmentSummary(
    client: PrismaService | Prisma.TransactionClient,
    projectId: string,
  ) {
    const project = await client.trainingProject.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        audienceMode: true,
        audienceRevision: true,
        assignments: {
          where: { revokedAt: null },
          orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            userId: true,
            assignedAt: true,
            user: {
              select: {
                name: true,
                email: true,
                status: true,
                deletedAt: true,
                role: {
                  select: {
                    permissions: {
                      where: {
                        permission: {
                          key: TRAINING_TAKE_PERMISSION,
                        },
                      },
                      select: { permissionId: true },
                    },
                  },
                },
                trainingTelegramAccount: {
                  select: {
                    revokedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!project) {
      return null;
    }
    const items = project.assignments.map((assignment) => ({
      id: assignment.id,
      userId: assignment.userId,
      name: assignment.user.name,
      email: assignment.user.email,
      status: assignment.user.status,
      eligible:
        assignment.user.status === UserStatus.ACTIVE &&
        assignment.user.deletedAt === null &&
        assignment.user.role.permissions.length === 1,
      telegramConnected:
        assignment.user.trainingTelegramAccount?.revokedAt === null,
      assignedAt: assignment.assignedAt.toISOString(),
    }));
    return {
      audienceMode: project.audienceMode,
      audienceRevision: project.audienceRevision,
      items,
      total: items.length,
      eligibleTotal: items.filter((item) => item.eligible).length,
    };
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    input: {
      action: string;
      actor: AuthenticatedUser;
      request: TrainingAuditRequest;
      projectId: string;
      metadata: Prisma.InputJsonObject;
    },
  ) {
    const forwardedFor = readHeader(input.request, 'x-forwarded-for');
    await tx.auditLog.create({
      data: {
        actorUserId: input.actor.id,
        action: input.action,
        entityType: 'training_project',
        entityId: input.projectId,
        metadata: input.metadata,
        ipAddress:
          forwardedFor?.split(',')[0]?.trim() ||
          input.request.ip ||
          input.request.socket?.remoteAddress ||
          null,
        userAgent: readHeader(input.request, 'user-agent'),
      },
    });
  }

  private async runSerializable<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2034'
          ) ||
          attempt === SERIALIZABLE_RETRY_LIMIT - 1
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

function assertMutableProject(
  project:
    | {
        status: TrainingProjectStatus;
      }
    | null,
): asserts project is { status: TrainingProjectStatus } {
  if (!project) {
    throw new NotFoundException('Training project not found');
  }
  if (project.status === TrainingProjectStatus.ARCHIVED) {
    throw new ConflictException('Archived training project is immutable');
  }
}

function assertExpectedRevision(actual: number, expected: number) {
  if (actual !== expected) {
    throw new ConflictException(
      `Training audience revision conflict: expected ${expected}, current ${actual}`,
    );
  }
}

function assertOnlyFields(
  body: Record<string, unknown>,
  allowedFields: string[],
) {
  const fields = Object.keys(body);
  const unsupported = fields.filter((field) => !allowedFields.includes(field));
  if (unsupported.length > 0) {
    throw new BadRequestException(
      `Unsupported fields: ${unsupported.join(', ')}`,
    );
  }
  if (fields.length !== allowedFields.length) {
    throw new BadRequestException(
      `Required fields: ${allowedFields.join(', ')}`,
    );
  }
}

function readAudienceMode(value: unknown) {
  if (
    typeof value !== 'string' ||
    !Object.values(TrainingProjectAudienceMode).includes(
      value.toUpperCase() as TrainingProjectAudienceMode,
    )
  ) {
    throw new BadRequestException('audienceMode is invalid');
  }
  return value.toUpperCase() as TrainingProjectAudienceMode;
}

function readUuidArray(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an array`);
  }
  if (value.length > MAX_ASSIGNMENTS_PER_PROJECT) {
    throw new BadRequestException(
      `${field} must contain at most ${MAX_ASSIGNMENTS_PER_PROJECT} values`,
    );
  }
  const userIds = value.map((item) => readUuid(item, field));
  if (new Set(userIds).size !== userIds.length) {
    throw new BadRequestException(`${field} must not contain duplicates`);
  }
  return userIds.sort();
}

function readUuid(value: unknown, field: string) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new BadRequestException(`${field} must contain UUID values`);
  }
  return value;
}

function readInteger(
  value: unknown,
  field: string,
  fallback: number | undefined,
  min: number,
  max: number,
) {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(
      `${field} must be an integer between ${min} and ${max}`,
    );
  }
  return parsed;
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new BadRequestException(
      `${field} must contain between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}

function sameStringArray(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readHeader(request: TrainingAuditRequest, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function eligibleTrainingUserWhere(): Prisma.UserWhereInput {
  return {
    status: UserStatus.ACTIVE,
    deletedAt: null,
    role: {
      permissions: {
        some: {
          permission: {
            key: TRAINING_TAKE_PERMISSION,
          },
        },
      },
    },
  };
}

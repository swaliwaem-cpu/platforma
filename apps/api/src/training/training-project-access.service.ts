import { randomUUID } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAttemptStatus,
  TrainingProjectAccessMode,
  TrainingProjectStatus,
  UserStatus,
} from '@prisma/client';
import type {
  BulkTrainingProjectAssignmentsRequest,
  BulkTrainingProjectAssignmentsResponse,
  TrainingProjectAssignmentFilter,
  TrainingProjectAssignmentUsersResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';

type DatabaseClient = PrismaService | Prisma.TransactionClient;

type AssignmentUsersQuery = {
  page: number;
  limit: number;
  search: string | null;
  assigned: TrainingProjectAssignmentFilter;
};

type ProjectAccessState = {
  status: TrainingProjectStatus;
  isOpen: boolean;
  accessMode: TrainingProjectAccessMode;
  assignments: readonly unknown[];
};

const participantPermissionWhere = {
  status: UserStatus.ACTIVE,
  deletedAt: null,
  role: {
    permissions: {
      some: { permission: { key: 'training:participate' } },
    },
  },
} as const satisfies Prisma.UserWhereInput;

@Injectable()
export class TrainingProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  participantWhere(userId: string): Prisma.UserWhereInput {
    return { id: userId, ...participantPermissionWhere };
  }

  newAttemptProjectWhere(userId: string): Prisma.TrainingProjectWhereInput {
    return {
      status: TrainingProjectStatus.PUBLISHED,
      isOpen: true,
      OR: [
        { accessMode: TrainingProjectAccessMode.ALL_PARTICIPANTS },
        {
          accessMode: TrainingProjectAccessMode.ASSIGNED_USERS,
          assignments: { some: { userId, revokedAt: null } },
        },
      ],
    };
  }

  hasCurrentAccess(project: ProjectAccessState) {
    return (
      project.status === TrainingProjectStatus.PUBLISHED &&
      project.isOpen &&
      (project.accessMode === TrainingProjectAccessMode.ALL_PARTICIPANTS ||
        project.assignments.length > 0)
    );
  }

  isAssignmentAccessRevoked(project: ProjectAccessState) {
    return (
      project.accessMode === TrainingProjectAccessMode.ASSIGNED_USERS &&
      project.assignments.length === 0
    );
  }

  employeeProjectWhere(userId: string): Prisma.TrainingProjectWhereInput {
    return {
      OR: [
        this.newAttemptProjectWhere(userId),
        {
          attempts: {
            some: { userId, status: TrainingAttemptStatus.IN_PROGRESS },
          },
        },
      ],
    };
  }

  async assertParticipant(userId: string, database: DatabaseClient = this.prisma) {
    const user = await database.user.findFirst({
      where: this.participantWhere(userId),
      select: { id: true },
    });

    if (!user) {
      throw new ForbiddenException('Training participation is not available');
    }
  }

  async assertNewAttemptAccess(
    projectId: string,
    userId: string,
    database: DatabaseClient = this.prisma,
  ) {
    await this.assertParticipant(userId, database);
    const project = await database.trainingProject.findFirst({
      where: { id: projectId, ...this.newAttemptProjectWhere(userId) },
      select: { id: true },
    });

    if (project) return;

    const existingProject = await database.trainingProject.findUnique({
      where: { id: projectId },
      select: { status: true, isOpen: true },
    });

    if (!existingProject) {
      throw new NotFoundException('Training project not found');
    }

    if (
      existingProject.status !== TrainingProjectStatus.PUBLISHED ||
      !existingProject.isOpen
    ) {
      throw new ConflictException('Training project is not open');
    }

    throw new ForbiddenException('Training project is not assigned to the user');
  }

  async listAssignmentUsers(
    projectId: string,
    query: AssignmentUsersQuery,
  ): Promise<TrainingProjectAssignmentUsersResponse> {
    await this.assertProjectExists(projectId);
    const assignmentWhere = { some: { projectId, revokedAt: null } };
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: UserStatus.ACTIVE,
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { email: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
      ...(query.assigned === 'yes'
        ? { trainingProjectAssignments: assignmentWhere }
        : query.assigned === 'no'
          ? { trainingProjectAssignments: { none: assignmentWhere.some } }
          : {}),
    };
    const [users, total, activeAssignments] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          role: {
            select: {
              permissions: {
                where: { permission: { key: 'training:participate' } },
                select: { permissionId: true },
                take: 1,
              },
            },
          },
          trainingProjectAssignments: {
            where: { projectId, revokedAt: null },
            select: { assignedAt: true },
            take: 1,
          },
        },
        orderBy: [{ name: 'asc' }, { email: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
      this.prisma.trainingProjectAssignment.count({
        where: { projectId, revokedAt: null },
      }),
    ]);

    return {
      items: users.map((user) => ({
        userId: user.id,
        name: user.name ?? '',
        email: user.email,
        status: user.status,
        canParticipate: user.role.permissions.length > 0,
        isAssigned: user.trainingProjectAssignments.length > 0,
        assignedAt:
          user.trainingProjectAssignments[0]?.assignedAt.toISOString() ?? null,
      })),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
      activeAssignments,
    };
  }

  async bulkAssignments(
    projectId: string,
    actorUserId: string,
    input: BulkTrainingProjectAssignmentsRequest,
  ): Promise<BulkTrainingProjectAssignmentsResponse> {
    const userIds = [...input.userIds].sort();

    return this.prisma.$transaction(async (transaction) => {
      await this.lockUsers(transaction, userIds);
      await this.lockProject(transaction, projectId);

      const users = await transaction.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, status: true, deletedAt: true },
      });

      if (users.length !== userIds.length || users.some((user) => user.deletedAt !== null)) {
        throw new NotFoundException('One or more users were not found');
      }
      if (
        input.action === 'ASSIGN' &&
        users.some((user) => user.status !== UserStatus.ACTIVE)
      ) {
        throw new ConflictException('Only active users can be assigned');
      }

      const now = await this.getDatabaseNow(transaction);
      let assigned = 0;
      let revoked = 0;

      if (input.action === 'ASSIGN') {
        const reactivated = await transaction.trainingProjectAssignment.updateMany({
          where: { projectId, userId: { in: userIds }, revokedAt: { not: null } },
          data: { revokedAt: null, assignedById: actorUserId, assignedAt: now },
        });
        const created = await transaction.trainingProjectAssignment.createMany({
          data: userIds.map((userId) => ({
            id: randomUUID(),
            projectId,
            userId,
            assignedById: actorUserId,
            assignedAt: now,
          })),
          skipDuplicates: true,
        });
        assigned = reactivated.count + created.count;
      } else {
        const result = await transaction.trainingProjectAssignment.updateMany({
          where: { projectId, userId: { in: userIds }, revokedAt: null },
          data: { revokedAt: now },
        });
        revoked = result.count;
      }

      const activeAssignments = await transaction.trainingProjectAssignment.count({
        where: { projectId, revokedAt: null },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId,
          action: `training.project_assignments.${input.action.toLowerCase()}`,
          entityType: 'training_project',
          entityId: projectId,
          metadata: {
            requestedCount: userIds.length,
            changedCount: input.action === 'ASSIGN' ? assigned : revoked,
            activeAssignments,
          },
        },
      });

      return {
        assigned,
        revoked,
        unchanged: userIds.length - assigned - revoked,
        activeAssignments,
      };
    });
  }

  async setAccessMode(
    projectId: string,
    actorUserId: string,
    accessMode: TrainingProjectAccessMode,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await this.lockProject(transaction, projectId);
      const project = await transaction.trainingProject.findUnique({
        where: { id: projectId },
        select: { accessMode: true },
      });

      if (!project) throw new NotFoundException('Training project not found');
      if (project.accessMode === accessMode) return;

      await transaction.trainingProject.update({
        where: { id: projectId },
        data: { accessMode },
      });
      await transaction.auditLog.create({
        data: {
          actorUserId,
          action: 'training.project_access_mode.update',
          entityType: 'training_project',
          entityId: projectId,
          metadata: { from: project.accessMode, to: accessMode },
        },
      });
    });
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.trainingProject.findUnique({
      where: { id: projectId },
      select: { id: true },
    });

    if (!project) throw new NotFoundException('Training project not found');
  }

  private async lockUsers(transaction: Prisma.TransactionClient, userIds: string[]) {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" IN (${Prisma.join(
        userIds.map((userId) => Prisma.sql`CAST(${userId} AS uuid)`),
      )}) ORDER BY "id" FOR UPDATE`,
    );

    if (rows.length !== userIds.length) {
      throw new NotFoundException('One or more users were not found');
    }
  }

  private async lockProject(transaction: Prisma.TransactionClient, projectId: string) {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "training_projects" WHERE "id" = CAST(${projectId} AS uuid) FOR UPDATE`,
    );

    if (!rows.length) throw new NotFoundException('Training project not found');
  }

  private async getDatabaseNow(transaction: Prisma.TransactionClient) {
    const [row] = await transaction.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
    );

    if (!row) throw new Error('Database timestamp unavailable');
    return row.now;
  }
}

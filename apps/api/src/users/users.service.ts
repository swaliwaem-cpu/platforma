import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

import { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { UploadedFile } from '../files/uploaded-file.type';
import { PrismaService } from '../prisma/prisma.service';
import { createSearchContainsFilters } from '../search/search-filters';

const userInclude = {
  role: true,
} as const;

const roleInclude = {
  permissions: {
    include: {
      permission: true,
    },
  },
} as const;

const authUserInclude = {
  role: {
    include: roleInclude,
  },
  profilePhotoFile: true,
} as const;

type UserWithRole = Prisma.UserGetPayload<{ include: typeof userInclude }>;
type AuthUserWithRole = Prisma.UserGetPayload<{ include: typeof authUserInclude }>;
type RoleWithPermissions = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

type RequestWithAudit = RequestWithAuth & {
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
};

type ListUsersQuery = {
  page?: string;
  limit?: string;
  search?: string;
  status?: string;
  roleId?: string;
};

type CreateUserBody = {
  email?: unknown;
  password?: unknown;
  name?: unknown;
  status?: unknown;
  roleId?: unknown;
};

type UpdateUserBody = {
  email?: unknown;
  password?: unknown;
  name?: unknown;
  status?: unknown;
  roleId?: unknown;
};

type UpdateOwnProfileBody = {
  name?: unknown;
  brokerPhone?: unknown;
  brokerEmail?: unknown;
};

type ChangeOwnPasswordBody = {
  currentPassword?: unknown;
  newPassword?: unknown;
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
  ) {}

  async list(query: ListUsersQuery) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const where: Prisma.UserWhereInput = {};
    const search = query.search?.trim();

    if (search) {
      where.OR = createSearchContainsFilters(search, ['email', 'name']);
    }

    if (query.status) {
      where.status = this.parseUserStatus(query.status);
    }

    if (query.roleId) {
      where.roleId = this.parseUuid(query.roleId, 'Role is invalid');
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: items.map((user) => this.serializeUser(user)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async listRoles() {
    const roles = await this.prisma.role.findMany({
      include: roleInclude,
      orderBy: {
        name: 'asc',
      },
    });

    return {
      items: roles.map((role) => this.serializeRole(role)),
    };
  }

  async getOwnProfilePhotoContent(actor: AuthenticatedUser) {
    const user = await this.findActiveUserForSession(actor.id);

    if (!user.profilePhotoFileId) {
      throw new NotFoundException('Profile photo not found');
    }

    return this.filesService.getContent(user.profilePhotoFileId);
  }

  async create(body: CreateUserBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    const email = this.parseEmail(body.email);
    const password = this.parsePassword(body.password);
    const roleId = this.parseUuid(this.parseRequiredString(body.roleId, 'Role is required'), 'Role is invalid');
    const status = body.status === undefined ? UserStatus.INVITED : this.parseUserStatus(body.status);
    const name = this.parseNullableName(body.name);

    await this.ensureRoleExists(roleId);

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        roleId,
        status,
      },
      include: userInclude,
    });

    await this.logUserAction({
      action: 'user.create',
      actor,
      request,
      entityId: user.id,
      metadata: {
        after: this.toAuditSnapshot(user),
      },
    });

    return {
      user: this.serializeUser(user),
    };
  }

  async update(id: string, body: UpdateUserBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    const user = await this.findExistingUser(id);
    const data: Prisma.UserUpdateInput = {};
    const changes: Record<string, Prisma.InputJsonValue> = {};
    let hasChanges = false;
    let roleChanged = false;
    let statusChanged = false;

    if ('email' in body) {
      const email = this.parseEmail(body.email);

      if (email !== user.email) {
        const existingUser = await this.prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });

        if (existingUser && existingUser.id !== user.id) {
          throw new ConflictException('User with this email already exists');
        }

        data.email = email;
        changes.email = this.change(user.email, email);
        hasChanges = true;
      }
    }

    if ('name' in body) {
      const name = this.parseNullableName(body.name);

      if (name !== user.name) {
        data.name = name;
        changes.name = this.change(user.name, name);
        hasChanges = true;
      }
    }

    if ('brokerPhone' in body) {
      const brokerPhone = this.parseNullableBrokerPhone(body.brokerPhone);

      if (brokerPhone !== user.brokerPhone) {
        data.brokerPhone = brokerPhone;
        changes.brokerPhone = this.change(user.brokerPhone, brokerPhone);
        hasChanges = true;
      }
    }

    if ('brokerEmail' in body) {
      const brokerEmail = this.parseNullableBrokerEmail(body.brokerEmail);

      if (brokerEmail !== user.brokerEmail) {
        data.brokerEmail = brokerEmail;
        changes.brokerEmail = this.change(user.brokerEmail, brokerEmail);
        hasChanges = true;
      }
    }

    if ('roleId' in body) {
      const roleId = this.parseUuid(this.parseRequiredString(body.roleId, 'Role is required'), 'Role is invalid');
      await this.ensureRoleExists(roleId);

      if (roleId !== user.roleId) {
        data.role = {
          connect: {
            id: roleId,
          },
        };
        data.refreshTokenHash = null;
        data.refreshTokenExpiresAt = null;
        data.sessions = {
          deleteMany: {},
        };
        changes.roleId = this.change(user.roleId, roleId);
        roleChanged = true;
        hasChanges = true;
      }
    }

    if ('status' in body) {
      const status = this.parseUserStatus(body.status);

      if (status !== user.status) {
        data.status = status;
        data.refreshTokenHash = null;
        data.refreshTokenExpiresAt = null;
        data.sessions = {
          deleteMany: {},
        };
        changes.status = this.change(user.status, status);
        statusChanged = true;
        hasChanges = true;
      }
    }

    if ('password' in body) {
      const password = this.parsePassword(body.password);
      data.passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      data.refreshTokenHash = null;
      data.refreshTokenExpiresAt = null;
      data.sessions = {
        deleteMany: {},
      };
      changes.password = {
        changed: true,
      };
      hasChanges = true;
    }

    if (!hasChanges) {
      return {
        user: this.serializeUser(user),
      };
    }

    const updatedUser = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data,
        include: userInclude,
      });

      await this.logUserAction(
        {
          action: 'user.update',
          actor,
          request,
          entityId: updated.id,
          metadata: {
            before: this.toAuditSnapshot(user),
            after: this.toAuditSnapshot(updated),
            changes,
          },
        },
        tx,
      );

      if (roleChanged) {
        await this.logUserAction(
          {
            action: 'user.role_change',
            actor,
            request,
            entityId: updated.id,
            metadata: {
              before: {
                roleId: user.roleId,
                roleName: user.role.name,
              },
              after: {
                roleId: updated.roleId,
                roleName: updated.role.name,
              },
            },
          },
          tx,
        );
        const canTakeTraining = await tx.rolePermission.findFirst({
          where: {
            roleId: updated.roleId,
            permission: { key: 'training:participate' },
          },
          select: { roleId: true },
        });
        if (!canTakeTraining) {
          await this.revokeTelegramAccountWithinTransaction(
            tx,
            updated.id,
            actor.id,
            'training_permission_removed',
          );
        }
      }

      if (statusChanged) {
        await this.logUserAction(
          {
            action: 'user.status_change',
            actor,
            request,
            entityId: updated.id,
            metadata: {
              before: {
                status: user.status,
              },
              after: {
                status: updated.status,
              },
            },
          },
          tx,
        );
        if (updated.status !== UserStatus.ACTIVE) {
          await this.revokeTelegramAccountWithinTransaction(
            tx,
            updated.id,
            actor.id,
            `user_status_${updated.status.toLowerCase()}`,
          );
        }
      }

      return updated;
    });

    return {
      user: this.serializeUser(updatedUser),
    };
  }

  async updateOwnProfile(body: UpdateOwnProfileBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    const user = await this.findActiveUserForSession(actor.id);
    const data: Prisma.UserUpdateInput = {};
    const changes: Record<string, Prisma.InputJsonValue> = {};
    let hasChanges = false;

    if ('name' in body) {
      const name = this.parseNullableName(body.name);

      if (name !== user.name) {
        data.name = name;
        changes.name = this.change(user.name, name);
        hasChanges = true;
      }
    }

    if ('brokerPhone' in body) {
      const brokerPhone = this.parseNullableBrokerPhone(body.brokerPhone);

      if (brokerPhone !== user.brokerPhone) {
        data.brokerPhone = brokerPhone;
        changes.brokerPhone = this.change(user.brokerPhone, brokerPhone);
        hasChanges = true;
      }
    }

    if ('brokerEmail' in body) {
      const brokerEmail = this.parseNullableBrokerEmail(body.brokerEmail);

      if (brokerEmail !== user.brokerEmail) {
        data.brokerEmail = brokerEmail;
        changes.brokerEmail = this.change(user.brokerEmail, brokerEmail);
        hasChanges = true;
      }
    }

    if (!hasChanges) {
      return {
        user: this.serializeAuthenticatedUser(user),
      };
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data,
      include: authUserInclude,
    });

    await this.logUserAction({
      action: 'user.profile_update',
      actor,
      request,
      entityId: updatedUser.id,
      metadata: {
        before: this.toAuditSnapshot(user),
        after: this.toAuditSnapshot(updatedUser),
        changes,
      },
    });

    return {
      user: this.serializeAuthenticatedUser(updatedUser),
    };
  }

  async changeOwnPassword(body: ChangeOwnPasswordBody, actor: AuthenticatedUser, request: RequestWithAudit) {
    const currentPassword = this.parseRequiredPassword(body.currentPassword, 'Current password is required');
    const newPassword = this.parsePassword(body.newPassword);
    const user = await this.findActiveUserForSession(actor.id);
    const passwordMatches = await argon2.verify(user.passwordHash, currentPassword);

    if (!passwordMatches) {
      throw new BadRequestException('Current password is invalid');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }),
      },
      include: authUserInclude,
    });

    await this.logUserAction({
      action: 'user.password_change',
      actor,
      request,
      entityId: updatedUser.id,
      metadata: {
        changes: {
          password: {
            changed: true,
          },
        },
      },
    });

    return {
      user: this.serializeAuthenticatedUser(updatedUser),
    };
  }

  async uploadOwnProfilePhoto(
    file: UploadedFile | undefined,
    actor: AuthenticatedUser,
    request: RequestWithAudit,
  ) {
    const user = await this.findActiveUserForSession(actor.id);
    const previousPhotoFileId = user.profilePhotoFileId;
    const uploadedFile = await this.filesService.uploadFile(file, actor, 'image');
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        profilePhotoFile: {
          connect: {
            id: uploadedFile.file.id,
          },
        },
      },
      include: authUserInclude,
    });

    await this.logUserAction({
      action: 'user.profile_photo_update',
      actor,
      request,
      entityId: updatedUser.id,
      metadata: {
        before: this.toAuditSnapshot(user),
        after: this.toAuditSnapshot(updatedUser),
        changes: {
          profilePhotoFileId: this.change(previousPhotoFileId, updatedUser.profilePhotoFileId),
        },
      },
    });

    if (previousPhotoFileId && previousPhotoFileId !== uploadedFile.file.id) {
      await this.filesService.deleteUnlinkedFile(previousPhotoFileId);
    }

    return {
      user: this.serializeAuthenticatedUser(updatedUser),
    };
  }

  async deactivate(id: string, actor: AuthenticatedUser, request: RequestWithAudit) {
    const user = await this.findExistingUser(id);

    if (user.status === UserStatus.DEACTIVATED) {
      return {
        user: this.serializeUser(user),
      };
    }

    const deactivatedUser = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          deletedAt: null,
          status: UserStatus.DEACTIVATED,
          refreshTokenHash: null,
          refreshTokenExpiresAt: null,
          sessions: {
            deleteMany: {},
          },
        },
        include: userInclude,
      });

      await this.logUserAction(
        {
          action: 'user.deactivate',
          actor,
          request,
          entityId: updated.id,
          metadata: {
            before: this.toAuditSnapshot(user),
            after: this.toAuditSnapshot(updated),
          },
        },
        tx,
      );
      await this.revokeTelegramAccountWithinTransaction(
        tx,
        updated.id,
        actor.id,
        'user_deactivated',
      );
      return updated;
    });

    return {
      user: this.serializeUser(deactivatedUser),
    };
  }

  async activate(id: string, actor: AuthenticatedUser, request: RequestWithAudit) {
    const user = await this.findExistingUser(id);

    if (user.status === UserStatus.ACTIVE) {
      return {
        user: this.serializeUser(user),
      };
    }

    const activatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        deletedAt: null,
        status: UserStatus.ACTIVE,
      },
      include: userInclude,
    });

    await this.logUserAction({
      action: 'user.activate',
      actor,
      request,
      entityId: activatedUser.id,
      metadata: {
        before: this.toAuditSnapshot(user),
        after: this.toAuditSnapshot(activatedUser),
      },
    });

    return {
      user: this.serializeUser(activatedUser),
    };
  }

  private async findExistingUser(id: string) {
    const userId = this.parseUuid(id, 'User is invalid');
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deletedAt: null,
      },
      include: userInclude,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private async findActiveUserForSession(id: string) {
    const userId = this.parseUuid(id, 'User is invalid');
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      include: authUserInclude,
    });

    if (!user) {
      throw new UnauthorizedException('User is not active');
    }

    return user;
  }

  private async ensureRoleExists(roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true },
    });

    if (!role) {
      throw new BadRequestException('Role does not exist');
    }
  }

  private parseEmail(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Email is required');
    }

    const email = value.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw new BadRequestException('Email is invalid');
    }

    return email;
  }

  private parsePassword(value: unknown) {
    if (typeof value !== 'string' || value.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    return value;
  }

  private parseRequiredPassword(value: unknown, message: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private parseNullableName(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Name must be a string');
    }

    const name = value.trim();

    return name.length > 0 ? name : null;
  }

  private parseNullableBrokerPhone(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Broker phone must be a string');
    }

    const brokerPhone = value.trim().replace(/\s+/gu, ' ');

    if (!brokerPhone) {
      return null;
    }

    if (brokerPhone.length > 64 || !/^[0-9+() .-]+$/u.test(brokerPhone)) {
      throw new BadRequestException('Broker phone is invalid');
    }

    return brokerPhone;
  }

  private parseNullableBrokerEmail(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Broker email must be a string');
    }

    const brokerEmail = value.trim().toLowerCase();

    if (!brokerEmail) {
      return null;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(brokerEmail) || brokerEmail.length > 320) {
      throw new BadRequestException('Broker email is invalid');
    }

    return brokerEmail;
  }

  private parseRequiredString(value: unknown, message: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(message);
    }

    return value.trim();
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private parseUserStatus(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('User status is required');
    }

    const normalizedStatus = value.trim().toUpperCase();

    if (!this.isUserStatus(normalizedStatus)) {
      throw new BadRequestException('User status is invalid');
    }

    return normalizedStatus;
  }

  private isUserStatus(value: string): value is UserStatus {
    return Object.values(UserStatus).includes(value as UserStatus);
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }

    return parsed;
  }

  private serializeUser(user: UserWithRole) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      brokerPhone: user.brokerPhone,
      brokerEmail: user.brokerEmail,
      status: user.status,
      role: {
        id: user.role.id,
        name: user.role.name,
      },
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      deletedAt: user.deletedAt?.toISOString() ?? null,
    };
  }

  private serializeAuthenticatedUser(user: AuthUserWithRole): AuthenticatedUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      brokerPhone: user.brokerPhone,
      brokerEmail: user.brokerEmail,
      status: user.status,
      role: {
        id: user.role.id,
        name: user.role.name,
      },
      profilePhotoFile: user.profilePhotoFile
        ? {
            id: user.profilePhotoFile.id,
            url: user.profilePhotoFile.url,
            originalName: user.profilePhotoFile.originalName,
            mimeType: user.profilePhotoFile.mimeType,
            updatedAt: user.profilePhotoFile.updatedAt.toISOString(),
          }
        : null,
      permissions: user.role.permissions.map(({ permission }) => permission.key),
    };
  }

  private serializeRole(role: RoleWithPermissions) {
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      permissions: role.permissions.map(({ permission }) => permission.key),
    };
  }

  private toAuditSnapshot(user: UserWithRole | AuthUserWithRole): Prisma.InputJsonObject {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      brokerPhone: user.brokerPhone,
      brokerEmail: user.brokerEmail,
      status: user.status,
      roleId: user.roleId,
      roleName: user.role.name,
      profilePhotoFileId: user.profilePhotoFileId,
      deletedAt: user.deletedAt?.toISOString() ?? null,
    };
  }

  private change(from: string | null, to: string | null): Prisma.InputJsonObject {
    return { from, to };
  }

  private async logUserAction(
    params: {
      action: string;
      actor: AuthenticatedUser;
      request: RequestWithAudit;
      entityId: string;
      metadata: Prisma.InputJsonObject;
    },
    client: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma,
  ) {
    await client.auditLog.create({
      data: {
        actorUserId: params.actor.id,
        action: params.action,
        entityType: 'user',
        entityId: params.entityId,
        metadata: params.metadata,
        ipAddress: this.getRequestIp(params.request),
        userAgent: this.getHeader(params.request, 'user-agent'),
      },
    });
  }

  private async revokeTelegramAccountWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    actorUserId: string,
    reason: string,
  ) {
    const account = await tx.trainingTelegramAccount.findFirst({
      where: { userId, revokedAt: null },
      select: { id: true, revokedAt: true },
    });

    const revokedAt = new Date();
    const revokedTokens = await tx.trainingTelegramLinkToken.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data: { revokedAt },
    });
    if (!account || account.revokedAt) return revokedTokens.count > 0;

    const revoked = await tx.trainingTelegramAccount.updateMany({
      where: { id: account.id, revokedAt: null },
      data: { revokedAt },
    });
    if (revoked.count !== 1) return revokedTokens.count > 0;
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'training.telegram.auto_revoke',
        entityType: 'training_telegram_account',
        entityId: account.id,
        metadata: {
          userId,
          accountId: account.id,
          reason,
        },
      },
    });
    return true;
  }

  private getRequestIp(request: RequestWithAudit) {
    const forwardedFor = this.getHeader(request, 'x-forwarded-for');

    return forwardedFor?.split(',')[0]?.trim() || request.ip || request.socket?.remoteAddress || null;
  }

  private getHeader(request: RequestWithAudit, name: string) {
    const value = request.headers[name];

    return Array.isArray(value) ? value[0] : value;
  }
}

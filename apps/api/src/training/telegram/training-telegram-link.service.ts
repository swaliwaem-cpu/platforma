import { createHash, randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingProjectStatus,
  TrainingVersionStatus,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { trainingProjectAudienceWhere } from '../training-project-access';
import { TrainingTelegramConfig } from './training-telegram.config';
import {
  enqueueTrainingTelegramOutboxEvent,
  TRAINING_TELEGRAM_OUTBOX_OPERATION,
} from './training-telegram-outbox';

const LINK_TOKEN_BYTES = 32;
const SERIALIZABLE_RETRY_LIMIT = 3;
const TRAINING_TAKE_PERMISSION = 'training:take';

export type TrainingTelegramIdentity = {
  telegramUserId: bigint;
  chatId: bigint;
  username?: string;
  firstName?: string;
  lastName?: string;
};

@Injectable()
export class TrainingTelegramLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TrainingTelegramConfig,
  ) {}

  async getAccount(userId: string) {
    const account = await this.prisma.trainingTelegramAccount.findUnique({
      where: { userId },
    });
    return {
      connected: account?.revokedAt === null,
      account:
        account?.revokedAt === null
          ? serializeEmployeeTelegramAccount(account)
          : null,
    };
  }

  async issueLinkToken(userId: string, projectId?: string) {
    if (!this.config.botUsername) {
      throw new ServiceUnavailableException(
        'Telegram bot username is not configured',
      );
    }
    await this.assertUserCanTake(userId);
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + this.config.linkTokenTtlMinutes * 60_000,
    );

    if (projectId) {
      await this.assertProjectCanStart(userId, projectId, now);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomBytes(LINK_TOKEN_BYTES).toString('base64url');
      const tokenHash = hashTrainingLinkToken(token);
      try {
        await this.runSerializable(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-link-token:${userId}`}, 0))) AS "lock_state"`,
          );
          const recentIssueCount = await tx.trainingLinkToken.count({
            where: {
              userId,
              createdAt: { gte: new Date(now.getTime() - 60 * 60_000) },
            },
          });
          if (recentIssueCount >= this.config.linkTokenMaxIssuesPerHour) {
            throw new HttpException(
              'Telegram link token issue limit exceeded',
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
          const activeToken = await tx.trainingLinkToken.findFirst({
            where: {
              userId,
              usedAt: null,
              revokedAt: null,
              expiresAt: { gt: now },
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          });
          if (
            activeToken &&
            now.getTime() - activeToken.createdAt.getTime() <
              this.config.linkTokenCooldownSeconds * 1_000
          ) {
            throw new HttpException(
              'Telegram link token was issued too recently',
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
          await tx.trainingLinkToken.updateMany({
            where: {
              userId,
              usedAt: null,
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
          await tx.trainingLinkToken.create({
            data: {
              userId,
              projectId: projectId ?? null,
              tokenHash,
              expiresAt,
              createdAt: now,
            },
          });
        });
        return {
          token,
          expiresAt: expiresAt.toISOString(),
          deepLink: `https://t.me/${this.config.botUsername}?start=${token}`,
          projectId: projectId ?? null,
        };
      } catch (error) {
        if (isUniqueConflict(error) && attempt < 2) continue;
        throw error;
      }
    }
    throw new ServiceUnavailableException('Could not create Telegram link token');
  }

  async consumeHashedToken(
    tokenHash: string,
    identity: TrainingTelegramIdentity,
  ) {
    assertTelegramIdentity(identity);
    if (!/^[0-9a-f]{64}$/u.test(tokenHash)) {
      throw new BadRequestException('Telegram link token is invalid');
    }
    const linkedAt = new Date();

    try {
      return await this.runSerializable(async (tx) => {
        const token = await tx.trainingLinkToken.findUnique({
          where: { tokenHash },
          include: {
            user: {
              select: {
                id: true,
                status: true,
                deletedAt: true,
                role: {
                  select: {
                    permissions: {
                      where: {
                        permission: { key: TRAINING_TAKE_PERMISSION },
                      },
                      select: {
                        permissionId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });
        if (!token) {
          throw new BadRequestException('Telegram link token is invalid');
        }
        if (!canTakeTraining(token.user)) {
          throw new ConflictException(
            'Platforma user is not authorized for training',
          );
        }

        const consumed = await tx.trainingLinkToken.updateMany({
          where: {
            id: token.id,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: linkedAt },
          },
          data: { usedAt: linkedAt },
        });
        if (consumed.count !== 1) {
          if (token.revokedAt) {
            throw new ConflictException('Telegram link token was revoked');
          }
          if (token.usedAt) {
            throw new ConflictException('Telegram link token was already used');
          }
          if (token.expiresAt <= linkedAt) {
            throw new ConflictException('Telegram link token has expired');
          }
          throw new ConflictException('Telegram link token cannot be consumed');
        }

        const [byUser, byTelegram, byChat] = await Promise.all([
          tx.trainingTelegramAccount.findUnique({
            where: { userId: token.userId },
          }),
          tx.trainingTelegramAccount.findUnique({
            where: { telegramUserId: identity.telegramUserId },
          }),
          tx.trainingTelegramAccount.findUnique({
            where: { chatId: identity.chatId },
          }),
        ]);

        for (const account of [byTelegram, byChat]) {
          if (account && account.userId !== token.userId) {
            throw new ConflictException(
              'Telegram account is already linked to another Platforma user',
            );
          }
        }
        if (
          byUser?.revokedAt === null &&
          (byUser.telegramUserId !== identity.telegramUserId ||
            byUser.chatId !== identity.chatId)
        ) {
          throw new ConflictException(
            'Platforma user already has another active Telegram account',
          );
        }
        if (
          byUser &&
          ((byTelegram && byTelegram.id !== byUser.id) ||
            (byChat && byChat.id !== byUser.id))
        ) {
          throw new ConflictException(
            'Telegram account linking conflicts with existing account history',
          );
        }

        const account = byUser
          ? await tx.trainingTelegramAccount.update({
              where: { id: byUser.id },
              data: {
                telegramUserId: identity.telegramUserId,
                chatId: identity.chatId,
                username: cleanTelegramMetadata(identity.username, 64),
                firstName: cleanTelegramMetadata(identity.firstName, 128),
                lastName: cleanTelegramMetadata(identity.lastName, 128),
                linkedAt,
                revokedAt: null,
              },
            })
          : await tx.trainingTelegramAccount.create({
              data: {
                userId: token.userId,
                telegramUserId: identity.telegramUserId,
                chatId: identity.chatId,
                username: cleanTelegramMetadata(identity.username, 64),
                firstName: cleanTelegramMetadata(identity.firstName, 128),
                lastName: cleanTelegramMetadata(identity.lastName, 128),
                linkedAt,
              },
            });

        await tx.trainingLinkToken.updateMany({
          where: {
            userId: token.userId,
            id: { not: token.id },
            usedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: linkedAt },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: token.userId,
            action: 'training.telegram.link',
            entityType: 'training_telegram_account',
            entityId: account.id,
            metadata: {
              userId: token.userId,
              accountId: account.id,
              projectId: token.projectId,
            },
          },
        });
        const welcomeKey = `telegram:link:${token.id}:welcome`;
        await enqueueTrainingTelegramOutboxEvent(tx, {
          idempotencyKey: welcomeKey,
          runAt: linkedAt,
          event: {
            operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
            eventType: 'ACCOUNT_LINKED',
            eventId: welcomeKey,
            userId: token.userId,
            accountId: account.id,
            chatId: account.chatId.toString(),
          },
        });
        if (token.projectId) {
          const projectKey = `telegram:link:${token.id}:project:${token.projectId}`;
          await enqueueTrainingTelegramOutboxEvent(tx, {
            idempotencyKey: projectKey,
            runAt: new Date(linkedAt.getTime() + 1),
            event: {
              operation: TRAINING_TELEGRAM_OUTBOX_OPERATION,
              eventType: 'PROJECT_CONFIRMATION',
              eventId: projectKey,
              userId: token.userId,
              accountId: account.id,
              chatId: account.chatId.toString(),
              projectId: token.projectId,
            },
          });
        }

        return {
          account: serializeTelegramAccount(account),
          userId: token.userId,
          projectId: token.projectId,
        };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException(
          'Telegram account linking conflicts with an existing account',
        );
      }
      throw error;
    }
  }

  async revokeAccount(userId: string) {
    const revokedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const account = await tx.trainingTelegramAccount.findUnique({
        where: { userId },
      });
      if (!account || account.revokedAt) {
        return;
      }
      const revoked = await tx.trainingTelegramAccount.updateMany({
        where: { id: account.id, revokedAt: null },
        data: { revokedAt },
      });
      if (revoked.count !== 1) return;
      await tx.trainingLinkToken.updateMany({
        where: { userId, usedAt: null, revokedAt: null },
        data: { revokedAt },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'training.telegram.unlink',
          entityType: 'training_telegram_account',
          entityId: account.id,
          metadata: {
            userId,
            accountId: account.id,
          },
        },
      });
    });
    return { connected: false, account: null };
  }

  async revokeLinkTokens(userId: string) {
    const revokedAt = new Date();
    return this.prisma.trainingLinkToken.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data: { revokedAt },
    });
  }

  async findAccountByTelegramUserId(telegramUserId: bigint) {
    return this.prisma.trainingTelegramAccount.findUnique({
      where: { telegramUserId },
      include: {
        user: {
          select: {
            status: true,
            deletedAt: true,
            role: {
              select: {
                permissions: {
                  where: {
                    permission: { key: TRAINING_TAKE_PERMISSION },
                  },
                  select: {
                    permissionId: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  async revokeInactiveAccount(accountId: string, userId: string) {
    const revokedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.trainingTelegramAccount.updateMany({
        where: {
          id: accountId,
          userId,
          revokedAt: null,
          user: {
            OR: [
              { status: { not: UserStatus.ACTIVE } },
              { deletedAt: { not: null } },
              {
                role: {
                  permissions: {
                    none: {
                      permission: { key: TRAINING_TAKE_PERMISSION },
                    },
                  },
                },
              },
            ],
          },
        },
        data: { revokedAt },
      });
      if (revoked.count !== 1) return false;
      await tx.trainingLinkToken.updateMany({
        where: { userId, usedAt: null, revokedAt: null },
        data: { revokedAt },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          action: 'training.telegram.auto_revoke',
          entityType: 'training_telegram_account',
          entityId: accountId,
          metadata: {
            userId,
            accountId,
            reason: 'inactive_or_unauthorized_user_update',
          },
        },
      });
      return true;
    });
  }

  private async assertProjectCanStart(
    userId: string,
    projectId: string,
    now: Date,
  ) {
    const project = await this.prisma.trainingProject.findFirst({
      where: {
        id: projectId,
        ...trainingProjectAudienceWhere(userId),
      },
      select: {
        status: true,
        availableFrom: true,
        deadlineAt: true,
        activeVersion: { select: { status: true } },
      },
    });
    if (!project) throw new NotFoundException('Training project not found');
    if (
      project.status !== TrainingProjectStatus.OPEN ||
      project.activeVersion?.status !== TrainingVersionStatus.PUBLISHED
    ) {
      throw new ConflictException('Training project is not open');
    }
    if (
      (project.availableFrom && now < project.availableFrom) ||
      (project.deadlineAt && now > project.deadlineAt)
    ) {
      throw new ConflictException('Training project is outside availability window');
    }
  }

  private async assertUserCanTake(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: UserStatus.ACTIVE,
        deletedAt: null,
        role: {
          permissions: {
            some: {
              permission: { key: TRAINING_TAKE_PERMISSION },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!user) {
      throw new ConflictException(
        'Platforma user is not authorized for training',
      );
    }
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
        if (!isSerializableConflict(error) || attempt === SERIALIZABLE_RETRY_LIMIT - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

function canTakeTraining(user: {
  status: UserStatus;
  deletedAt: Date | null;
  role: {
    permissions: Array<{ permissionId: string }>;
  };
}) {
  return (
    user.status === UserStatus.ACTIVE &&
    user.deletedAt === null &&
    user.role.permissions.length === 1
  );
}

export function hashTrainingLinkToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/u.test(token)) {
    throw new BadRequestException('Telegram link token is invalid');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function serializeTelegramAccount(account: {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  linkedAt: Date;
}) {
  const displayName =
    [account.firstName, account.lastName].filter(Boolean).join(' ').trim() ||
    (account.username ? `@${account.username}` : null);
  return {
    id: account.id,
    username: account.username,
    firstName: account.firstName,
    lastName: account.lastName,
    displayName,
    linkedAt: account.linkedAt.toISOString(),
  };
}

function serializeEmployeeTelegramAccount(account: {
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  linkedAt: Date;
}) {
  const {
    id: _internalId,
    ...safeAccount
  } = serializeTelegramAccount({ id: 'internal', ...account });
  return safeAccount;
}

function cleanTelegramMetadata(value: string | undefined, maximum: number) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function assertTelegramIdentity(identity: TrainingTelegramIdentity) {
  if (identity.telegramUserId <= 0n || identity.chatId <= 0n) {
    throw new BadRequestException('Telegram identity is invalid');
  }
}

function isUniqueConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function isSerializableConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  );
}

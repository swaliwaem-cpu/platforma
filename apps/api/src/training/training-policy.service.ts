import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingPolicyAcceptanceSource,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const POLICY_TRANSACTION_RETRY_LIMIT = 3;

@Injectable()
export class TrainingPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrentPolicy(userId: string) {
    const policy = await this.prisma.trainingPolicyVersion.findFirst({
      where: {
        isActive: true,
        effectiveAt: { lte: new Date() },
      },
      include: {
        acceptances: {
          where: { userId, revokedAt: null },
          orderBy: { acceptedAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!policy) {
      throw policyUnavailable();
    }
    return serializePolicy(policy, policy.acceptances[0] ?? null);
  }

  async accept(userId: string, source: TrainingPolicyAcceptanceSource) {
    return this.runSerializable(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-policy:${userId}`}, 0))) AS "lock_state"`,
      );

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { status: true, deletedAt: true },
      });
      if (
        !user ||
        user.status !== UserStatus.ACTIVE ||
        user.deletedAt !== null
      ) {
        throw new ConflictException({
          code: 'TRAINING_POLICY_USER_INACTIVE',
          message: 'Only an active user can accept the training policy',
        });
      }

      const policy = await this.findCurrentPolicy(tx, new Date());
      const existing = await tx.trainingPolicyAcceptance.findFirst({
        where: {
          userId,
          policyVersionId: policy.id,
          revokedAt: null,
        },
        orderBy: { acceptedAt: 'desc' },
      });
      if (existing) {
        return serializePolicy(policy, existing);
      }

      const acceptance = await tx.trainingPolicyAcceptance.create({
        data: {
          userId,
          policyVersionId: policy.id,
          source,
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: userId,
          action: 'training.policy.accept',
          entityType: 'training_policy_version',
          entityId: policy.id,
          metadata: {
            policyVersion: policy.version,
            policyChecksum: policy.checksum,
            source,
          },
        },
      });
      return serializePolicy(policy, acceptance);
    });
  }

  async assertCurrentPolicyAccepted(
    tx: Prisma.TransactionClient,
    userId: string,
    at: Date,
  ) {
    const policy = await this.findCurrentPolicy(tx, at);
    const acceptance = await tx.trainingPolicyAcceptance.findFirst({
      where: {
        userId,
        policyVersionId: policy.id,
        revokedAt: null,
        acceptedAt: { lte: at },
      },
      select: { id: true },
    });
    if (!acceptance) {
      throw new ConflictException({
        code: 'TRAINING_POLICY_ACCEPTANCE_REQUIRED',
        message: 'Current training policy must be accepted before starting',
        policyVersion: policy.version,
      });
    }
    return policy;
  }

  private async findCurrentPolicy(tx: Prisma.TransactionClient, at: Date) {
    const policy = await tx.trainingPolicyVersion.findFirst({
      where: {
        isActive: true,
        effectiveAt: { lte: at },
      },
    });
    if (!policy) throw policyUnavailable();
    return policy;
  }

  private async runSerializable<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < POLICY_TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(callback, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (!isSerializableConflict(error) || attempt === POLICY_TRANSACTION_RETRY_LIMIT - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}

function serializePolicy(
  policy: {
    id: string;
    version: string;
    title: string;
    body: string;
    checksum: string;
    effectiveAt: Date;
    isActive: boolean;
    approvalStatus: string;
  },
  acceptance: {
    acceptedAt: Date;
    source: TrainingPolicyAcceptanceSource;
  } | null,
) {
  return {
    policy: {
      id: policy.id,
      version: policy.version,
      title: policy.title,
      body: policy.body,
      checksum: policy.checksum,
      effectiveAt: policy.effectiveAt.toISOString(),
      isActive: policy.isActive,
      approvalStatus: policy.approvalStatus,
    },
    acceptance: acceptance
      ? {
          acceptedAt: acceptance.acceptedAt.toISOString(),
          source: acceptance.source,
        }
      : null,
    accepted: acceptance !== null,
  };
}

function policyUnavailable() {
  return new ServiceUnavailableException({
    code: 'TRAINING_POLICY_UNAVAILABLE',
    message: 'Active training policy is not configured',
  });
}

function isSerializableConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  );
}

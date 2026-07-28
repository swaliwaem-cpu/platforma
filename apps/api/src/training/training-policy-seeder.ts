import type { Prisma } from '@prisma/client';

export type TrainingPolicySeedInput = {
  version: string;
  title: string;
  body: string;
  effectiveAt: string;
  isActive: boolean;
  approvalStatus: string;
  checksum: string;
};

export async function seedImmutableTrainingPolicy(
  tx: Prisma.TransactionClient,
  policy: TrainingPolicySeedInput,
  createdById: string,
) {
  const existing = await tx.trainingPolicyVersion.findUnique({
    where: { version: policy.version },
    select: {
      id: true,
      title: true,
      body: true,
      effectiveAt: true,
      checksum: true,
      isActive: true,
      approvalStatus: true,
      createdById: true,
    },
  });
  const effectiveAt = new Date(policy.effectiveAt);

  if (existing) {
    const matchesImmutableContent =
      existing.title === policy.title &&
      existing.body === policy.body &&
      existing.effectiveAt.getTime() === effectiveAt.getTime() &&
      existing.checksum === policy.checksum &&
      existing.isActive === policy.isActive &&
      existing.approvalStatus === policy.approvalStatus &&
      existing.createdById === createdById;
    if (!matchesImmutableContent) {
      throw new Error(
        `Training policy version "${policy.version}" does not match the approved immutable seed contract`,
      );
    }
    return { id: existing.id, created: false };
  }

  await tx.trainingPolicyVersion.updateMany({
    where: { isActive: true },
    data: { isActive: false },
  });
  const created = await tx.trainingPolicyVersion.create({
    data: {
      version: policy.version,
      title: policy.title,
      body: policy.body,
      checksum: policy.checksum,
      effectiveAt,
      isActive: policy.isActive,
      approvalStatus: policy.approvalStatus,
      createdById,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

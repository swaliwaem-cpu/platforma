import type { Prisma } from '@prisma/client';

export const trainingProjectRepositoryInclude = {
  realEstateObject: {
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
    },
  },
  activeVersion: {
    include: {
      questions: {
        orderBy: [{ type: 'asc' }, { position: 'asc' }],
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
    },
  },
} satisfies Prisma.TrainingProjectInclude;

export const trainingAttemptRepositoryInclude = {
  user: {
    select: {
      id: true,
      email: true,
      name: true,
    },
  },
  project: true,
  projectVersion: true,
  attemptQuestions: {
    orderBy: { sequence: 'asc' },
    include: {
      question: true,
      answer: {
        include: {
          voiceSegments: {
            orderBy: { segmentIndex: 'asc' },
          },
          evaluations: {
            orderBy: { evaluationNumber: 'asc' },
            include: {
              scoreComponents: {
                orderBy: { componentKey: 'asc' },
              },
            },
          },
        },
      },
    },
  },
  reviews: {
    orderBy: { reviewNumber: 'asc' },
  },
} satisfies Prisma.TrainingAttemptInclude;

export const trainingJobClaimSelect = {
  id: true,
  kind: true,
  status: true,
  payloadJson: true,
  idempotencyKey: true,
  runAt: true,
  attempts: true,
  maxAttempts: true,
  lockOwner: true,
  lockedAt: true,
  heartbeatAt: true,
} satisfies Prisma.TrainingJobSelect;

export type TrainingProjectRepositoryRecord = Prisma.TrainingProjectGetPayload<{
  include: typeof trainingProjectRepositoryInclude;
}>;

export type TrainingAttemptRepositoryRecord = Prisma.TrainingAttemptGetPayload<{
  include: typeof trainingAttemptRepositoryInclude;
}>;

export type TrainingJobClaimRecord = Prisma.TrainingJobGetPayload<{
  select: typeof trainingJobClaimSelect;
}>;

export type TrainingTransactionClient = Prisma.TransactionClient;

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingVersionStatus,
} from '@prisma/client';
import type { TrainingAttemptSettingsSnapshot } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import {
  TRAINING_ATTEMPT_CLOCK,
  TRAINING_EVALUATION_PROVIDER,
  TRAINING_QUESTION_SELECTOR,
  TRAINING_TRANSCRIPTION_PROVIDER,
  type TrainingAttemptClock,
  type TrainingEvaluationInput,
  type TrainingEvaluationProvider,
  type TrainingQuestionSelector,
  type TrainingTranscriptionProvider,
} from './training-attempt.providers';
import {
  clampTrainingAttemptScore,
  scoreTrainingEvaluation,
} from './training-attempt.scoring';
import {
  TRAINING_ACTIVE_ATTEMPT_STATUSES,
  TRAINING_ATTEMPT_QUESTION_COUNT,
  TRAINING_FOLLOW_UP_POOL_SIZE,
  TRAINING_SELECTED_FOLLOW_UP_COUNT,
  TRAINING_TOTAL_MAX_SCORE,
} from './training.domain';
import { trainingAttemptRepositoryInclude } from './training.repository.types';

const TRAINING_TERMINAL_ATTEMPT_STATUSES = [
  TrainingAttemptStatus.COMPLETED,
  TrainingAttemptStatus.REQUIRES_REVIEW,
  TrainingAttemptStatus.EXPIRED,
  TrainingAttemptStatus.TECHNICAL_FAILURE,
] as const;

const TRAINING_CURRENT_QUESTION_STATUSES = [
  TrainingAttemptQuestionStatus.PRESENTED,
  TrainingAttemptQuestionStatus.COLLECTING,
  TrainingAttemptQuestionStatus.LOCKED,
  TrainingAttemptQuestionStatus.PROCESSING,
] as const;

const TRAINING_FAKE_TRANSCRIPT_MAX_LENGTH = 240;
const TRAINING_TRANSACTION_RETRY_LIMIT = 3;

export type ConfirmTrainingAttemptStartCommand = {
  userId: string;
  projectId: string;
  confirmed: boolean;
};

export type AppendFakeTrainingVoiceSegmentCommand = {
  attemptId: string;
  kind: 'VOICE' | 'TEXT' | 'AUDIO' | 'DOCUMENT' | 'VIDEO_NOTE';
  updateId: bigint;
  fakeTranscript: string;
  recordingStartedAt: Date;
  receivedAt?: Date;
  durationSeconds?: number;
};

export type FinishTrainingAnswerCommand = {
  attemptId: string;
  attemptQuestionId: string;
};

export type RefundTechnicalTrainingAttemptCommand = {
  attemptId: string;
  actorUserId: string;
  reason: string;
};

@Injectable()
export class TrainingAttemptEngineService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TRAINING_ATTEMPT_CLOCK)
    private readonly clock: TrainingAttemptClock,
    @Inject(TRAINING_QUESTION_SELECTOR)
    private readonly questionSelector: TrainingQuestionSelector,
    @Inject(TRAINING_TRANSCRIPTION_PROVIDER)
    private readonly transcriptionProvider: TrainingTranscriptionProvider,
    @Inject(TRAINING_EVALUATION_PROVIDER)
    private readonly evaluationProvider: TrainingEvaluationProvider,
  ) {}

  async confirmStart(command: ConfirmTrainingAttemptStartCommand) {
    if (!command.confirmed) {
      throw new BadRequestException('Training attempt start must be explicitly confirmed');
    }

    const startedAt = this.clock.now();

    try {
      const attemptId = await this.runSerializable(async (tx) => {
        await this.acquireUserProjectLock(tx, command.userId, command.projectId);

        const project = await tx.trainingProject.findUnique({
          where: { id: command.projectId },
          include: {
            activeVersion: {
              include: {
                questions: {
                  where: { isActive: true },
                  orderBy: [{ type: 'asc' }, { position: 'asc' }],
                },
              },
            },
          },
        });

        if (!project) {
          throw new NotFoundException('Training project not found');
        }
        if (project.status !== TrainingProjectStatus.OPEN) {
          throw new ConflictException('Training project is not open');
        }
        if (!project.activeVersion) {
          throw new ConflictException('Training project has no active version');
        }
        if (project.activeVersion.status !== TrainingVersionStatus.PUBLISHED) {
          throw new ConflictException('Training project active version is not published');
        }

        this.assertProjectAvailable(project.availableFrom, project.deadlineAt, startedAt);

        const attempts = await tx.trainingAttempt.findMany({
          where: {
            userId: command.userId,
            projectId: command.projectId,
          },
          orderBy: { attemptNumber: 'desc' },
          select: {
            attemptNumber: true,
            status: true,
            isConsumed: true,
            startedAt: true,
            completedAt: true,
            finalScore: true,
            passStatus: true,
            reviewStatus: true,
          },
        });
        const activeAttempt = attempts.find((attempt) =>
          TRAINING_ACTIVE_ATTEMPT_STATUSES.includes(
            attempt.status as (typeof TRAINING_ACTIVE_ATTEMPT_STATUSES)[number],
          ),
        );

        if (activeAttempt) {
          throw new ConflictException('Training project already has an active attempt');
        }

        const consumedAttempts = attempts.filter((attempt) => attempt.isConsumed);
        if (consumedAttempts.length >= project.activeVersion.attemptLimit) {
          throw new ConflictException('Training attempt limit is exhausted');
        }

        const hasPassed = consumedAttempts.some(
          (attempt) =>
            attempt.passStatus === TrainingPassStatus.PASSED &&
            attempt.finalScore !== null &&
            attempt.reviewStatus !== TrainingReviewStatus.PENDING,
        );
        if (hasPassed && !project.activeVersion.allowRetakeAfterPass) {
          throw new ConflictException('Retake after passing is disabled for this project');
        }

        const lastConsumedAttempt = consumedAttempts[0];
        if (lastConsumedAttempt) {
          const cooldownStartedAt =
            lastConsumedAttempt.completedAt ?? lastConsumedAttempt.startedAt;
          const cooldownEndsAt = new Date(
            cooldownStartedAt.getTime() +
              project.activeVersion.cooldownMinutes * 60_000,
          );
          if (startedAt < cooldownEndsAt) {
            throw new ConflictException(
              `Training attempt cooldown is active until ${cooldownEndsAt.toISOString()}`,
            );
          }
        }

        const mainQuestions = project.activeVersion.questions.filter(
          (question) => question.type === TrainingQuestionType.MAIN,
        );
        const followUpQuestions = project.activeVersion.questions.filter(
          (question) => question.type === TrainingQuestionType.FOLLOW_UP,
        );
        if (
          mainQuestions.length !== 1 ||
          followUpQuestions.length !== TRAINING_FOLLOW_UP_POOL_SIZE
        ) {
          throw new ConflictException(
            'Published training version does not have the required 1 + 10 question shape',
          );
        }

        const selectedFollowUps = this.questionSelector.select(
          followUpQuestions,
          TRAINING_SELECTED_FOLLOW_UP_COUNT,
        );
        if (
          selectedFollowUps.length !== TRAINING_SELECTED_FOLLOW_UP_COUNT ||
          new Set(selectedFollowUps.map((selection) => selection.candidate.id)).size !==
            TRAINING_SELECTED_FOLLOW_UP_COUNT
        ) {
          throw new ConflictException(
            'Training follow-up selector must return three different questions',
          );
        }

        const expiresAt = new Date(
          startedAt.getTime() +
            project.activeVersion.totalTimeLimitSeconds * 1_000,
        );
        const graceExpiresAt = new Date(
          expiresAt.getTime() + project.activeVersion.finishGraceSeconds * 1_000,
        );
        const attemptNumber =
          Math.max(0, ...attempts.map((attempt) => attempt.attemptNumber)) + 1;
        const settingsSnapshot = this.createSettingsSnapshot(project.activeVersion);
        const attempt = await tx.trainingAttempt.create({
          data: {
            userId: command.userId,
            projectId: command.projectId,
            projectVersionId: project.activeVersion.id,
            attemptNumber,
            status: TrainingAttemptStatus.AWAITING_MAIN,
            isConsumed: true,
            startedAt,
            expiresAt,
            graceExpiresAt,
            settingsSnapshotJson:
              settingsSnapshot as unknown as Prisma.InputJsonObject,
          },
          select: { id: true },
        });

        await tx.trainingAttemptQuestion.createMany({
          data: [
            {
              attemptId: attempt.id,
              questionId: mainQuestions[0]!.id,
              sequence: 1,
              status: TrainingAttemptQuestionStatus.PRESENTED,
              presentedAt: startedAt,
              selectionMetadataJson: {
                source: 'fixed-main',
              },
            },
            ...selectedFollowUps.map((selection, index) => ({
              attemptId: attempt.id,
              questionId: selection.candidate.id,
              sequence: index + 2,
              status: TrainingAttemptQuestionStatus.PENDING,
              selectionRandomIndex: selection.randomIndex,
              selectionMetadataJson: {
                source: 'crypto-random-without-replacement',
                poolSize: TRAINING_FOLLOW_UP_POOL_SIZE,
              },
            })),
          ],
        });

        await tx.trainingJob.createMany({
          data: [
            ...settingsSnapshot.warningSeconds.map((warningSeconds) => ({
              kind: TrainingJobKind.SEND_TIMER_WARNING,
              status: TrainingJobStatus.PENDING,
              payloadJson: {
                attemptId: attempt.id,
                warningSeconds,
              },
              idempotencyKey: `attempt:${attempt.id}:timer:warning:${warningSeconds}`,
              runAt: new Date(expiresAt.getTime() - warningSeconds * 1_000),
            })),
            {
              kind: TrainingJobKind.EXPIRE_ATTEMPT,
              status: TrainingJobStatus.PENDING,
              payloadJson: { attemptId: attempt.id },
              idempotencyKey: `attempt:${attempt.id}:timer:expire`,
              runAt: expiresAt,
            },
          ],
          skipDuplicates: true,
        });

        return attempt.id;
      });

      return this.getAttempt(attemptId);
    } catch (error) {
      if (this.isPrismaConcurrencyError(error)) {
        throw new ConflictException(
          'Training attempt start conflicted with another start command',
        );
      }
      throw error;
    }
  }

  async appendVoiceSegment(command: AppendFakeTrainingVoiceSegmentCommand) {
    if (command.kind !== 'VOICE') {
      throw new BadRequestException('Only voice segments are accepted');
    }
    if (command.updateId <= 0n) {
      throw new BadRequestException('Fake voice update ID must be positive');
    }
    const fakeTranscript = command.fakeTranscript.trim();
    if (
      fakeTranscript.length === 0 ||
      fakeTranscript.length > TRAINING_FAKE_TRANSCRIPT_MAX_LENGTH
    ) {
      throw new BadRequestException('Fake voice transcript is invalid');
    }
    if (
      command.durationSeconds !== undefined &&
      (!Number.isInteger(command.durationSeconds) || command.durationSeconds < 0)
    ) {
      throw new BadRequestException('Fake voice duration is invalid');
    }

    const receivedAt = command.receivedAt ?? this.clock.now();
    const result = await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);

      const duplicate = await tx.trainingVoiceSegment.findUnique({
        where: { telegramUpdateId: command.updateId },
        include: {
          answer: {
            include: {
              attemptQuestion: {
                select: { id: true, attemptId: true },
              },
            },
          },
        },
      });
      if (duplicate) {
        if (duplicate.answer.attemptQuestion.attemptId !== command.attemptId) {
          throw new ConflictException('Fake voice update belongs to another attempt');
        }
        return {
          autoFinish: false,
          duplicate: true,
          attemptQuestionId: duplicate.answer.attemptQuestion.id,
        };
      }

      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: command.attemptId },
        include: {
          attemptQuestions: {
            orderBy: { sequence: 'asc' },
            include: {
              answer: {
                include: {
                  voiceSegments: {
                    orderBy: { segmentIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (this.isTerminalAttemptStatus(attempt.status)) {
        throw new ConflictException('Training attempt is already finalized');
      }

      const currentQuestion = this.findCurrentQuestion(attempt.attemptQuestions);
      if (
        !currentQuestion ||
        (currentQuestion.status !== TrainingAttemptQuestionStatus.PRESENTED &&
          currentQuestion.status !== TrainingAttemptQuestionStatus.COLLECTING)
      ) {
        throw new ConflictException('Training attempt is not collecting an answer');
      }

      const isExpired = receivedAt >= attempt.expiresAt;
      if (isExpired) {
        if (receivedAt > attempt.graceExpiresAt) {
          throw new ConflictException('Training attempt grace period has expired');
        }
        if (command.recordingStartedAt > attempt.expiresAt) {
          throw new ConflictException(
            'Only a voice recording started before timeout can finish in grace',
          );
        }
        const graceSegments =
          currentQuestion.answer?.voiceSegments.filter(
            (segment) => segment.receivedAt >= attempt.expiresAt,
          ).length ?? 0;
        if (graceSegments > 0) {
          throw new ConflictException('Only one voice segment is accepted in grace');
        }

        await this.skipFutureQuestions(
          tx,
          attempt.id,
          currentQuestion.sequence,
          receivedAt,
        );
        await tx.trainingAttempt.update({
          where: { id: attempt.id },
          data: { status: TrainingAttemptStatus.FINALIZING },
        });
      } else if (attempt.status === TrainingAttemptStatus.FINALIZING) {
        throw new ConflictException('Training attempt is finalizing');
      }

      const answer =
        currentQuestion.answer ??
        (await tx.trainingAnswer.create({
          data: {
            attemptQuestionId: currentQuestion.id,
            status: TrainingAnswerStatus.COLLECTING,
          },
        }));
      const segmentIndex = (currentQuestion.answer?.voiceSegments.length ?? 0) + 1;

      await tx.trainingVoiceSegment.create({
        data: {
          answerId: answer.id,
          segmentIndex,
          telegramUpdateId: command.updateId,
          telegramMessageId: command.updateId,
          telegramChatId: 1n,
          telegramFileId: `fake:${command.updateId.toString()}`,
          fileUniqueId: fakeTranscript,
          mimeType: 'audio/ogg',
          durationSeconds: command.durationSeconds ?? null,
          receivedAt,
        },
      });

      await tx.trainingAttemptQuestion.update({
        where: { id: currentQuestion.id },
        data: {
          status: TrainingAttemptQuestionStatus.COLLECTING,
          firstSegmentAt: currentQuestion.firstSegmentAt ?? receivedAt,
        },
      });

      return {
        autoFinish: isExpired,
        duplicate: false,
        attemptQuestionId: currentQuestion.id,
      };
    });

    if (result.autoFinish) {
      return this.finishAnswer({
        attemptId: command.attemptId,
        attemptQuestionId: result.attemptQuestionId,
      });
    }
    return this.getAttempt(command.attemptId);
  }

  async finishAnswer(command: FinishTrainingAnswerCommand) {
    const answerId = await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);

      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: command.attemptId },
        include: {
          attemptQuestions: {
            orderBy: { sequence: 'asc' },
            include: {
              answer: {
                include: {
                  voiceSegments: {
                    orderBy: { segmentIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (this.isTerminalAttemptStatus(attempt.status)) {
        return null;
      }

      const targetQuestion = attempt.attemptQuestions.find(
        (question) => question.id === command.attemptQuestionId,
      );
      if (!targetQuestion) {
        throw new NotFoundException('Training attempt question not found');
      }
      if (
        targetQuestion.status === TrainingAttemptQuestionStatus.SCORED ||
        targetQuestion.answer?.status === TrainingAnswerStatus.SCORED
      ) {
        return null;
      }

      const currentQuestion = this.findCurrentQuestion(attempt.attemptQuestions);
      if (currentQuestion?.id !== targetQuestion.id) {
        throw new ConflictException('Training answer is no longer current');
      }
      if (!targetQuestion.answer || targetQuestion.answer.voiceSegments.length === 0) {
        throw new BadRequestException('Current training answer has no voice segments');
      }

      const answer = targetQuestion.answer;
      if (
        answer.status === TrainingAnswerStatus.TRANSCRIBING ||
        answer.status === TrainingAnswerStatus.EVALUATING
      ) {
        return null;
      }
      if (answer.status === TrainingAnswerStatus.FAILED) {
        throw new ConflictException('Current training answer has failed');
      }

      if (answer.status === TrainingAnswerStatus.COLLECTING) {
        await tx.trainingAnswer.update({
          where: { id: answer.id },
          data: { status: TrainingAnswerStatus.READY },
        });
        await tx.trainingAttemptQuestion.update({
          where: { id: targetQuestion.id },
          data: {
            status: TrainingAttemptQuestionStatus.LOCKED,
            finishedAt: this.clock.now(),
          },
        });
        await tx.trainingAttempt.update({
          where: { id: attempt.id },
          data: {
            status:
              targetQuestion.sequence === 1
                ? TrainingAttemptStatus.PROCESSING_MAIN
                : TrainingAttemptStatus.PROCESSING_FOLLOW_UP,
          },
        });
      }

      return answer.id;
    });

    if (answerId) {
      await this.processReadyAnswer(answerId);
    }
    return this.getAttempt(command.attemptId);
  }

  async handleTimeout(attemptId: string, currentTime = this.clock.now()) {
    const result = await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, attemptId);

      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: attemptId },
        include: {
          attemptQuestions: {
            orderBy: { sequence: 'asc' },
            include: {
              answer: {
                include: {
                  voiceSegments: {
                    orderBy: { segmentIndex: 'asc' },
                  },
                },
              },
            },
          },
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (this.isTerminalAttemptStatus(attempt.status)) {
        return { answerId: null };
      }
      if (currentTime < attempt.expiresAt) {
        throw new ConflictException('Training attempt timer has not expired');
      }

      const currentQuestion = this.findCurrentQuestion(attempt.attemptQuestions);
      if (!currentQuestion) {
        await this.finalizeWithinTransaction(tx, attempt.id, currentTime);
        return { answerId: null };
      }

      await this.skipFutureQuestions(
        tx,
        attempt.id,
        currentQuestion.sequence,
        currentTime,
      );
      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: { status: TrainingAttemptStatus.FINALIZING },
      });

      if (currentTime < attempt.graceExpiresAt) {
        return { answerId: null };
      }

      const answer = currentQuestion.answer;
      if (
        answer &&
        answer.voiceSegments.length > 0 &&
        (answer.status === TrainingAnswerStatus.COLLECTING ||
          answer.status === TrainingAnswerStatus.READY)
      ) {
        if (answer.status === TrainingAnswerStatus.COLLECTING) {
          await tx.trainingAnswer.update({
            where: { id: answer.id },
            data: { status: TrainingAnswerStatus.READY },
          });
          await tx.trainingAttemptQuestion.update({
            where: { id: currentQuestion.id },
            data: {
              status: TrainingAttemptQuestionStatus.LOCKED,
              finishedAt: currentTime,
            },
          });
        }
        return { answerId: answer.id };
      }

      if (
        !answer ||
        answer.voiceSegments.length === 0 ||
        currentQuestion.status === TrainingAttemptQuestionStatus.PRESENTED
      ) {
        await tx.trainingAttemptQuestion.update({
          where: { id: currentQuestion.id },
          data: {
            status: TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT,
            finishedAt: currentTime,
          },
        });
        await this.finalizeWithinTransaction(tx, attempt.id, currentTime);
      }

      return { answerId: null };
    });

    if (result.answerId) {
      await this.processReadyAnswer(result.answerId);
    }
    return this.getAttempt(attemptId);
  }

  async finalizeAttempt(attemptId: string) {
    const now = this.clock.now();
    const state = await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, attemptId);

      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: attemptId },
        select: {
          id: true,
          status: true,
          expiresAt: true,
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (this.isTerminalAttemptStatus(attempt.status)) {
        return 'finalized' as const;
      }
      if (now >= attempt.expiresAt) {
        return 'timeout' as const;
      }

      const finalized = await this.finalizeWithinTransaction(tx, attempt.id, now);
      if (!finalized) {
        throw new ConflictException('Training attempt still has unfinished questions');
      }
      return 'finalized' as const;
    });

    if (state === 'timeout') {
      return this.handleTimeout(attemptId, now);
    }
    return this.getAttempt(attemptId);
  }

  async refundTechnicalFailure(command: RefundTechnicalTrainingAttemptCommand) {
    const reason = command.reason.trim();
    if (!reason || reason.length > 2_000) {
      throw new BadRequestException('Technical failure refund reason is required');
    }

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: command.attemptId },
        select: {
          id: true,
          userId: true,
          projectId: true,
          status: true,
          isConsumed: true,
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (attempt.status !== TrainingAttemptStatus.TECHNICAL_FAILURE) {
        throw new ConflictException('Only a technical failure attempt can be refunded');
      }
      if (!attempt.isConsumed) {
        return;
      }

      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: { isConsumed: false },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: command.actorUserId,
          action: 'training.attempt.refund',
          entityType: 'training_attempt',
          entityId: attempt.id,
          metadata: {
            userId: attempt.userId,
            projectId: attempt.projectId,
            reason,
          },
        },
      });
    });

    return this.getAttempt(command.attemptId);
  }

  async getAttempt(attemptId: string) {
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: trainingAttemptRepositoryInclude,
    });
    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }
    return { attempt };
  }

  async getBestReviewedScore(userId: string, projectId: string) {
    const attempt = await this.prisma.trainingAttempt.findFirst({
      where: {
        userId,
        projectId,
        isConsumed: true,
        finalScore: { not: null },
        reviewStatus: { not: TrainingReviewStatus.PENDING },
        status: {
          in: [
            TrainingAttemptStatus.COMPLETED,
            TrainingAttemptStatus.REQUIRES_REVIEW,
          ],
        },
      },
      orderBy: [{ finalScore: 'desc' }, { completedAt: 'asc' }],
      select: {
        id: true,
        finalScore: true,
        reviewStatus: true,
        completedAt: true,
      },
    });

    return {
      bestReviewedScore: attempt?.finalScore ?? null,
      attemptId: attempt?.id ?? null,
    };
  }

  private async processReadyAnswer(answerId: string) {
    const claimed = await this.prisma.trainingAnswer.updateMany({
      where: {
        id: answerId,
        status: TrainingAnswerStatus.READY,
      },
      data: {
        status: TrainingAnswerStatus.TRANSCRIBING,
        processingStartedAt: this.clock.now(),
        errorCode: null,
        errorMessage: null,
      },
    });
    if (claimed.count === 0) {
      return;
    }

    try {
      const context = await this.prisma.trainingAnswer.findUnique({
        where: { id: answerId },
        include: {
          voiceSegments: {
            orderBy: { segmentIndex: 'asc' },
          },
          attemptQuestion: {
            include: {
              question: {
                include: {
                  factLinks: {
                    include: {
                      fact: true,
                    },
                  },
                },
              },
              attempt: {
                include: {
                  projectVersion: true,
                },
              },
            },
          },
        },
      });
      if (!context) {
        throw new NotFoundException('Training answer not found');
      }

      const transcription = await this.transcriptionProvider.transcribe({
        answerId: context.id,
        segments: context.voiceSegments.map((segment) => ({
          id: segment.id,
          segmentIndex: segment.segmentIndex,
          fakeTranscript: segment.fileUniqueId,
        })),
      });
      await this.prisma.trainingAnswer.update({
        where: { id: context.id },
        data: {
          status: TrainingAnswerStatus.EVALUATING,
          combinedTranscript: transcription.transcript,
          normalizedLanguage: transcription.language,
          transcriptionProvider: transcription.provider,
          transcriptionModel: transcription.model,
          transcriptionRequestId: transcription.requestId,
        },
      });

      const criteria = await this.prisma.trainingEvaluationCriterion.findMany({
        where: {
          projectVersionId: context.attemptQuestion.attempt.projectVersionId,
          questionType: context.attemptQuestion.question.type,
        },
        orderBy: { sortOrder: 'asc' },
      });
      const facts = context.attemptQuestion.question.factLinks
        .map((link) => link.fact)
        .filter((fact) => fact.isApproved);
      const evaluationInput: TrainingEvaluationInput = {
        answerId: context.id,
        questionId: context.attemptQuestion.question.id,
        questionText: context.attemptQuestion.question.text,
        questionMaxScore: context.attemptQuestion.question.maxScore,
        transcript: transcription.transcript,
        criteria: criteria.map((criterion) => ({
          id: criterion.id,
          code: criterion.code,
          title: criterion.title,
          maxPoints: Number(criterion.maxPoints),
        })),
        facts: facts.map((fact) => ({
          id: fact.id,
          code: fact.code,
          statement: fact.statement,
        })),
      };
      const evaluation = await this.evaluationProvider.evaluate(evaluationInput);
      const score = scoreTrainingEvaluation({
        questionMaxScore: evaluationInput.questionMaxScore,
        criteria: evaluationInput.criteria,
        facts: evaluationInput.facts,
        evaluation,
      });
      const completedAt = this.clock.now();

      await this.runSerializable(async (tx) => {
        await this.acquireAttemptLock(
          tx,
          context.attemptQuestion.attemptId,
        );
        const existingEvaluation = await tx.trainingAnswerEvaluation.findFirst({
          where: {
            answerId: context.id,
            evaluationNumber: 1,
          },
          select: { id: true },
        });

        if (!existingEvaluation) {
          await tx.trainingAnswerEvaluation.create({
            data: {
              answerId: context.id,
              evaluationNumber: 1,
              actualModelId: evaluation.actualModelId,
              reasoningEffort: evaluation.reasoningEffort,
              promptVersion:
                context.attemptQuestion.attempt.projectVersion.promptVersion,
              schemaVersion:
                context.attemptQuestion.attempt.projectVersion.schemaVersion,
              rubricVersion: `${context.attemptQuestion.attempt.projectVersion.versionNumber}`,
              structuredResultJson:
                evaluation as unknown as Prisma.InputJsonObject,
              aiSuggestedScore: score.aiSuggestedScore,
              serverScore: score.serverScore,
              summary: evaluation.summary.slice(0, 2_000),
              requiresReview: score.requiresReview,
              reviewReasonsJson: score.reviewReasons,
              latencyMs: evaluation.latencyMs,
              requestId: evaluation.requestId,
              startedAt: context.processingStartedAt ?? completedAt,
              completedAt,
              scoreComponents: {
                create: score.components.map((component) => ({
                  criterionId: component.criterionId,
                  factId: component.factId,
                  componentKey: component.componentKey,
                  title: component.title,
                  awardedPoints: component.awardedPoints,
                  maxPoints: component.maxPoints,
                  factVerdict: component.factVerdict,
                  evidenceJson: component.evidence
                    ? (component.evidence as Prisma.InputJsonObject)
                    : undefined,
                  penaltyPoints: component.penaltyPoints,
                })),
              },
            },
          });
        }

        await tx.trainingAnswer.update({
          where: { id: context.id },
          data: {
            status: TrainingAnswerStatus.SCORED,
            processingFinishedAt: completedAt,
          },
        });
        await tx.trainingAttemptQuestion.update({
          where: { id: context.attemptQuestion.id },
          data: {
            status: TrainingAttemptQuestionStatus.SCORED,
            finishedAt: context.attemptQuestion.finishedAt ?? completedAt,
            responseTimeSeconds: calculateDurationSeconds(
              context.attemptQuestion.presentedAt,
              context.attemptQuestion.firstSegmentAt,
            ),
            answerDurationSeconds: context.voiceSegments.reduce(
              (total, segment) => total + (segment.durationSeconds ?? 0),
              0,
            ),
          },
        });

        await this.advanceOrFinalize(
          tx,
          context.attemptQuestion.attemptId,
          context.attemptQuestion.sequence,
          completedAt,
        );
      });
    } catch (error) {
      await this.markTechnicalFailure(answerId, error);
      throw error;
    }
  }

  private async advanceOrFinalize(
    tx: Prisma.TransactionClient,
    attemptId: string,
    completedSequence: number,
    now: Date,
  ) {
    const attempt = await tx.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
        },
      },
    });
    if (!attempt || this.isTerminalAttemptStatus(attempt.status)) {
      return;
    }

    const timeExpired =
      now >= attempt.expiresAt || attempt.status === TrainingAttemptStatus.FINALIZING;
    if (completedSequence >= TRAINING_ATTEMPT_QUESTION_COUNT || timeExpired) {
      if (timeExpired) {
        await this.skipFutureQuestions(tx, attempt.id, completedSequence, now);
      }
      await this.finalizeWithinTransaction(tx, attempt.id, now);
      return;
    }

    const nextQuestion = attempt.attemptQuestions.find(
      (question) => question.sequence === completedSequence + 1,
    );
    if (!nextQuestion) {
      throw new ConflictException('Training attempt has no next question');
    }

    await tx.trainingAttemptQuestion.update({
      where: { id: nextQuestion.id },
      data: {
        status: TrainingAttemptQuestionStatus.PRESENTED,
        presentedAt: now,
      },
    });
    await tx.trainingAttempt.update({
      where: { id: attempt.id },
      data: { status: TrainingAttemptStatus.AWAITING_FOLLOW_UP },
    });
  }

  private async finalizeWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    completedAt: Date,
  ) {
    const attempt = await tx.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          include: {
            answer: {
              include: {
                evaluations: {
                  where: { evaluationNumber: 1 },
                  orderBy: { evaluationNumber: 'asc' },
                },
              },
            },
          },
        },
      },
    });
    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }
    if (this.isTerminalAttemptStatus(attempt.status)) {
      return true;
    }

    const unfinishedQuestions = attempt.attemptQuestions.filter(
      (question) =>
        question.status !== TrainingAttemptQuestionStatus.SCORED &&
        question.status !== TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT,
    );
    if (unfinishedQuestions.length > 0) {
      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: { status: TrainingAttemptStatus.FINALIZING },
      });
      return false;
    }

    const evaluations = attempt.attemptQuestions.flatMap(
      (question) => question.answer?.evaluations ?? [],
    );
    const aiScore = clampTrainingAttemptScore(
      evaluations.reduce(
        (total, evaluation) => total + Number(evaluation.aiSuggestedScore),
        0,
      ),
    );
    const serverScore = clampTrainingAttemptScore(
      evaluations.reduce(
        (total, evaluation) => total + Number(evaluation.serverScore),
        0,
      ),
    );
    const requiresReview = evaluations.some(
      (evaluation) => evaluation.requiresReview,
    );
    const settings = this.readSettingsSnapshot(attempt.settingsSnapshotJson);
    const passStatus = requiresReview
      ? TrainingPassStatus.PENDING
      : serverScore >= settings.passScore
        ? TrainingPassStatus.PASSED
        : TrainingPassStatus.FAILED;
    const status = requiresReview
      ? TrainingAttemptStatus.REQUIRES_REVIEW
      : TrainingAttemptStatus.COMPLETED;
    const reviewStatus = requiresReview
      ? TrainingReviewStatus.PENDING
      : TrainingReviewStatus.NOT_REQUIRED;
    const summary = evaluations
      .map((evaluation) => evaluation.summary)
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .slice(0, 2_000);

    await tx.trainingAttempt.update({
      where: { id: attempt.id },
      data: {
        status,
        completedAt,
        aiScore,
        serverScore,
        finalScore: requiresReview ? null : serverScore,
        passStatus,
        reviewStatus,
        summary: summary || null,
        totalDurationSeconds: Math.max(
          0,
          Math.floor((completedAt.getTime() - attempt.startedAt.getTime()) / 1_000),
        ),
      },
    });
    await tx.trainingJob.updateMany({
      where: {
        idempotencyKey: {
          startsWith: `attempt:${attempt.id}:timer:`,
        },
        status: TrainingJobStatus.PENDING,
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt: completedAt,
      },
    });
    return true;
  }

  private async markTechnicalFailure(answerId: string, error: unknown) {
    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: {
        id: true,
        attemptQuestion: {
          select: {
            attemptId: true,
          },
        },
      },
    });
    if (!answer) {
      return;
    }

    const message = (error instanceof Error ? error.message : 'Fake provider failed')
      .replace(/[\r\n]+/gu, ' ')
      .slice(0, 2_000);
    const completedAt = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.trainingAnswer.update({
        where: { id: answer.id },
        data: {
          status: TrainingAnswerStatus.FAILED,
          processingFinishedAt: completedAt,
          errorCode: 'FAKE_PROVIDER_FAILED',
          errorMessage: message,
        },
      }),
      this.prisma.trainingAttempt.update({
        where: { id: answer.attemptQuestion.attemptId },
        data: {
          status: TrainingAttemptStatus.TECHNICAL_FAILURE,
          completedAt,
          passStatus: TrainingPassStatus.PENDING,
        },
      }),
    ]);
  }

  private async skipFutureQuestions(
    tx: Prisma.TransactionClient,
    attemptId: string,
    currentSequence: number,
    finishedAt: Date,
  ) {
    await tx.trainingAttemptQuestion.updateMany({
      where: {
        attemptId,
        sequence: { gt: currentSequence },
        status: {
          in: [
            TrainingAttemptQuestionStatus.PENDING,
            TrainingAttemptQuestionStatus.PRESENTED,
          ],
        },
      },
      data: {
        status: TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT,
        finishedAt,
      },
    });
  }

  private findCurrentQuestion<
    T extends {
      status: TrainingAttemptQuestionStatus;
      sequence: number;
    },
  >(questions: T[]) {
    return questions.find((question) =>
      TRAINING_CURRENT_QUESTION_STATUSES.includes(
        question.status as (typeof TRAINING_CURRENT_QUESTION_STATUSES)[number],
      ),
    );
  }

  private createSettingsSnapshot(version: {
    id: string;
    versionNumber: number;
    passScore: number;
    attemptLimit: number;
    cooldownMinutes: number;
    totalTimeLimitSeconds: number;
    finishGraceSeconds: number;
    warningSecondsJson: Prisma.JsonValue;
    allowRetakeAfterPass: boolean;
    mainMaxScore: number;
    followUpMaxScore: number;
    promptVersion: string;
    schemaVersion: string;
  }): TrainingAttemptSettingsSnapshot {
    if (version.mainMaxScore !== 55 || version.followUpMaxScore !== 15) {
      throw new ConflictException('Training version score caps are invalid');
    }

    return {
      versionId: version.id,
      versionNumber: version.versionNumber,
      passScore: version.passScore,
      attemptLimit: version.attemptLimit,
      cooldownMinutes: version.cooldownMinutes,
      totalTimeLimitSeconds: version.totalTimeLimitSeconds,
      finishGraceSeconds: version.finishGraceSeconds,
      warningSeconds: this.readWarningSeconds(version.warningSecondsJson),
      allowRetakeAfterPass: version.allowRetakeAfterPass,
      mainMaxScore: 55,
      followUpMaxScore: 15,
      promptVersion: version.promptVersion,
      schemaVersion: version.schemaVersion,
    };
  }

  private readWarningSeconds(value: Prisma.JsonValue) {
    if (!Array.isArray(value)) {
      throw new ConflictException('Training warning settings are invalid');
    }
    const warningSeconds = value.filter(
      (item): item is number =>
        typeof item === 'number' && Number.isInteger(item) && item > 0,
    );
    if (warningSeconds.length !== value.length) {
      throw new ConflictException('Training warning settings are invalid');
    }
    return [...new Set(warningSeconds)].sort((left, right) => right - left);
  }

  private readSettingsSnapshot(value: Prisma.JsonValue) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      typeof value.passScore !== 'number'
    ) {
      throw new ConflictException('Training attempt settings snapshot is invalid');
    }
    return value as unknown as TrainingAttemptSettingsSnapshot;
  }

  private assertProjectAvailable(
    availableFrom: Date | null,
    deadlineAt: Date | null,
    now: Date,
  ) {
    if (availableFrom && now < availableFrom) {
      throw new ConflictException('Training project availability window has not started');
    }
    if (deadlineAt && now > deadlineAt) {
      throw new ConflictException('Training project deadline has expired');
    }
  }

  private async acquireUserProjectLock(
    tx: Prisma.TransactionClient,
    userId: string,
    projectId: string,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-attempt:${userId}:${projectId}`}, 0))) AS "lock_state"`,
    );
  }

  private async acquireAttemptLock(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-attempt-id:${attemptId}`}, 0))) AS "lock_state"`,
    );
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= TRAINING_TRANSACTION_RETRY_LIMIT; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2034'
          ) ||
          attempt === TRAINING_TRANSACTION_RETRY_LIMIT
        ) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  private isPrismaConcurrencyError(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    );
  }

  private isTerminalAttemptStatus(status: TrainingAttemptStatus) {
    return TRAINING_TERMINAL_ATTEMPT_STATUSES.includes(
      status as (typeof TRAINING_TERMINAL_ATTEMPT_STATUSES)[number],
    );
  }
}

function calculateDurationSeconds(start: Date | null, end: Date | null) {
  if (!start || !end) {
    return null;
  }
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1_000));
}

export const TRAINING_ATTEMPT_SCORE_MAXIMUM = TRAINING_TOTAL_MAX_SCORE;

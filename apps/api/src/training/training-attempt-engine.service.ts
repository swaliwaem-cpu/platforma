import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
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
  canonicalTrainingScore,
  sumTrainingScores,
  trainingScoreMeetsThreshold,
} from './training-score-decimal';
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
const TRAINING_ATTEMPT_JOB_POLL_MS = 250;
const TRAINING_ATTEMPT_JOB_LEASE_MS = 30_000;
const TRAINING_ATTEMPT_JOB_HEARTBEAT_MS = 5_000;
const TRAINING_ATTEMPT_PROCESS_JOB_KINDS = [
  TrainingJobKind.TRANSCRIBE_ANSWER,
  TrainingJobKind.EVALUATE_ANSWER,
  TrainingJobKind.FINALIZE_ATTEMPT,
  TrainingJobKind.EXPIRE_ATTEMPT,
] as const;
const TRAINING_ATTEMPT_CLOSABLE_JOB_STATUSES = [
  TrainingJobStatus.PENDING,
  TrainingJobStatus.RUNNING,
  TrainingJobStatus.FAILED,
] as const;

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
  telegramMessageId?: bigint;
  telegramChatId?: bigint;
  telegramFileId?: string;
  fileUniqueId?: string;
  sizeBytes?: bigint;
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

export type ReviewTrainingAttemptCommand = {
  attemptId: string;
  reviewerId: string;
  decision: 'APPROVED' | 'OVERRIDDEN';
  adminScore?: Prisma.Decimal | number | string;
  comment: string;
  unsupportedClaimsDecisions?: Prisma.InputJsonArray;
};

type ClaimedTrainingAttemptJob = {
  id: string;
  kind: TrainingJobKind;
  payloadJson: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
};

@Injectable()
export class TrainingAttemptEngineService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingAttemptEngineService.name);
  private readonly workerId = `training-attempt:${process.pid}:${randomUUID()}`;
  private pollInterval: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private kickQueued = false;
  private destroyed = false;
  private readonly heartbeatIntervals = new Set<NodeJS.Timeout>();

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

  onModuleInit() {
    this.destroyed = false;
    this.pollInterval = setInterval(
      () => this.kickRecovery(),
      TRAINING_ATTEMPT_JOB_POLL_MS,
    );
    this.pollInterval.unref();
    this.kickRecovery();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const interval of this.heartbeatIntervals) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();
  }

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
    if (
      command.telegramMessageId !== undefined &&
      command.telegramMessageId <= 0n
    ) {
      throw new BadRequestException('Telegram voice message ID must be positive');
    }
    if (command.telegramChatId !== undefined && command.telegramChatId <= 0n) {
      throw new BadRequestException('Telegram voice chat ID must be positive');
    }
    if (command.sizeBytes !== undefined && command.sizeBytes < 0n) {
      throw new BadRequestException('Telegram voice file size is invalid');
    }
    const telegramFileId =
      command.telegramFileId?.trim() ?? `fake:${command.updateId.toString()}`;
    const fileUniqueId = command.fileUniqueId?.trim() ?? fakeTranscript;
    if (
      telegramFileId.length === 0 ||
      telegramFileId.length > 256 ||
      fileUniqueId.length === 0 ||
      fileUniqueId.length > 256
    ) {
      throw new BadRequestException('Telegram voice file identity is invalid');
    }
    const telegramMessageId = command.telegramMessageId ?? command.updateId;
    const telegramChatId = command.telegramChatId ?? 1n;

    const receivedAt = command.receivedAt ?? this.clock.now();
    const result = await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);

      const duplicate =
        (await tx.trainingVoiceSegment.findUnique({
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
        })) ??
        (await tx.trainingVoiceSegment.findUnique({
          where: {
            telegramChatId_telegramMessageId: {
              telegramChatId,
              telegramMessageId,
            },
          },
          include: {
            answer: {
              include: {
                attemptQuestion: {
                  select: { id: true, attemptId: true },
                },
              },
            },
          },
        }));
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
        if (command.recordingStartedAt >= attempt.expiresAt) {
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
        await this.persistTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          attempt.graceExpiresAt,
          receivedAt,
          'GRACE_SEGMENT',
        );
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
          telegramMessageId,
          telegramChatId,
          telegramFileId,
          fileUniqueId,
          mimeType: 'audio/ogg',
          sizeBytes: command.sizeBytes ?? null,
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
      if (answer.status === TrainingAnswerStatus.FAILED) {
        throw new ConflictException('Current training answer has failed');
      }

      const finishedAt = this.clock.now();
      const timeoutStarted =
        attempt.status === TrainingAttemptStatus.FINALIZING ||
        finishedAt >= attempt.expiresAt;
      if (answer.status === TrainingAnswerStatus.COLLECTING) {
        await tx.trainingAnswer.update({
          where: { id: answer.id },
          data: { status: TrainingAnswerStatus.READY },
        });
        await tx.trainingAttemptQuestion.update({
          where: { id: targetQuestion.id },
          data: {
            status: TrainingAttemptQuestionStatus.LOCKED,
            finishedAt,
          },
        });
      }

      if (timeoutStarted) {
        await this.skipFutureQuestions(
          tx,
          attempt.id,
          targetQuestion.sequence,
          finishedAt,
        );
        await tx.trainingAttempt.update({
          where: { id: attempt.id },
          data: { status: TrainingAttemptStatus.FINALIZING },
        });
        await this.persistTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          attempt.graceExpiresAt,
          finishedAt,
          'PROCESSING',
        );
      } else {
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

      await this.enqueueAnswerJobWithinTransaction(
        tx,
        answer.status === TrainingAnswerStatus.EVALUATING
          ? TrainingJobKind.EVALUATE_ANSWER
          : TrainingJobKind.TRANSCRIBE_ANSWER,
        attempt.id,
        answer.id,
        finishedAt,
      );
      return answer.id;
    });

    if (answerId) {
      await this.drainAttemptJobs(true);
    }
    return this.getAttempt(command.attemptId);
  }

  async handleTimeout(
    attemptId: string,
    currentTime = this.clock.now(),
    drainJobs = true,
  ) {
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
        await this.closeAttemptJobsWithinTransaction(tx, attempt.id, currentTime);
        return { shouldDrain: false };
      }
      if (currentTime < attempt.expiresAt) {
        throw new ConflictException('Training attempt timer has not expired');
      }

      const currentQuestion = this.findCurrentQuestion(attempt.attemptQuestions);
      if (!currentQuestion) {
        await this.enqueueFinalizeJobWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
        await this.completeTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
        return { shouldDrain: true };
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

      const answer = currentQuestion.answer;
      const answerIsProcessing =
        answer &&
        (answer.status === TrainingAnswerStatus.READY ||
          answer.status === TrainingAnswerStatus.TRANSCRIBING ||
          answer.status === TrainingAnswerStatus.EVALUATING);

      if (answerIsProcessing) {
        await this.enqueueAnswerJobWithinTransaction(
          tx,
          answer.status === TrainingAnswerStatus.EVALUATING
            ? TrainingJobKind.EVALUATE_ANSWER
            : TrainingJobKind.TRANSCRIBE_ANSWER,
          attempt.id,
          answer.id,
          currentTime,
        );
        await this.completeTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
        return { shouldDrain: true };
      }

      if (answer?.status === TrainingAnswerStatus.SCORED) {
        await this.enqueueFinalizeJobWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
        await this.completeTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
        return { shouldDrain: true };
      }

      if (currentTime < attempt.graceExpiresAt) {
        await this.persistTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          attempt.graceExpiresAt,
          currentTime,
          'GRACE',
        );
        return { shouldDrain: false };
      }

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
        await this.enqueueAnswerJobWithinTransaction(
          tx,
          TrainingJobKind.TRANSCRIBE_ANSWER,
          attempt.id,
          answer.id,
          currentTime,
        );
        await this.completeTimeoutIntentWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
        return { shouldDrain: true };
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
        await this.enqueueFinalizeJobWithinTransaction(
          tx,
          attempt.id,
          currentTime,
        );
      }

      await this.completeTimeoutIntentWithinTransaction(
        tx,
        attempt.id,
        currentTime,
      );
      return { shouldDrain: true };
    });

    if (result.shouldDrain && drainJobs && !this.drainPromise) {
      await this.drainAttemptJobs(true);
    }
    return this.getAttempt(attemptId);
  }

  async finalizeAttempt(attemptId: string) {
    const now = this.clock.now();
    const state = await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, attemptId);

      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: attemptId },
        include: {
          attemptQuestions: {
            select: {
              status: true,
            },
          },
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (this.isTerminalAttemptStatus(attempt.status)) {
        await this.closeAttemptJobsWithinTransaction(tx, attempt.id, now);
        return 'finalized' as const;
      }
      if (now >= attempt.expiresAt) {
        return 'timeout' as const;
      }

      const unfinished = attempt.attemptQuestions.some(
        (question) =>
          question.status !== TrainingAttemptQuestionStatus.SCORED &&
          question.status !== TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT,
      );
      if (unfinished) {
        throw new ConflictException('Training attempt still has unfinished questions');
      }

      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: { status: TrainingAttemptStatus.FINALIZING },
      });
      await this.enqueueFinalizeJobWithinTransaction(tx, attempt.id, now);
      return 'finalized' as const;
    });

    if (state === 'timeout') {
      return this.handleTimeout(attemptId, now);
    }
    await this.drainAttemptJobs(true);
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
      await this.closeAttemptJobsWithinTransaction(
        tx,
        attempt.id,
        this.clock.now(),
      );
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

  async reviewAttempt(command: ReviewTrainingAttemptCommand) {
    const comment = command.comment.trim();
    if (!comment || comment.length > 2_000) {
      throw new BadRequestException('Training review comment is required');
    }
    if (
      command.decision === 'APPROVED' &&
      command.adminScore !== undefined
    ) {
      throw new BadRequestException('Approved review cannot override the score');
    }
    if (
      command.decision === 'OVERRIDDEN' &&
      command.adminScore === undefined
    ) {
      throw new BadRequestException('Overridden review score is required');
    }

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: command.attemptId },
        include: {
          reviews: {
            orderBy: { reviewNumber: 'desc' },
            take: 1,
          },
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (
        attempt.status !== TrainingAttemptStatus.COMPLETED &&
        attempt.status !== TrainingAttemptStatus.REQUIRES_REVIEW
      ) {
        throw new ConflictException('Training attempt is not reviewable');
      }
      if (attempt.serverScore === null) {
        throw new ConflictException('Training attempt has no server score');
      }

      const serverScore = clampTrainingAttemptScore(attempt.serverScore);
      const adminScore =
        command.decision === 'OVERRIDDEN'
          ? clampTrainingAttemptScore(command.adminScore!)
          : null;
      const finalScore = adminScore ?? serverScore;
      const settings = this.readSettingsSnapshot(attempt.settingsSnapshotJson);
      const reviewStatus =
        command.decision === 'OVERRIDDEN'
          ? TrainingReviewStatus.OVERRIDDEN
          : TrainingReviewStatus.APPROVED;
      const reviewedAt = this.clock.now();

      await tx.trainingResultReview.create({
        data: {
          attemptId: attempt.id,
          reviewerId: command.reviewerId,
          reviewNumber: (attempt.reviews[0]?.reviewNumber ?? 0) + 1,
          previousFinalScore: attempt.finalScore,
          adminScore,
          finalScore,
          decision: reviewStatus,
          comment,
          unsupportedClaimsDecisionsJson:
            command.unsupportedClaimsDecisions ?? [],
          reviewedAt,
        },
      });
      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: {
          status: TrainingAttemptStatus.COMPLETED,
          adminScore,
          finalScore,
          passStatus: trainingScoreMeetsThreshold(
            finalScore,
            settings.passScore,
          )
            ? TrainingPassStatus.PASSED
            : TrainingPassStatus.FAILED,
          reviewStatus,
          completedAt: attempt.completedAt ?? reviewedAt,
        },
      });
      await this.closeAttemptJobsWithinTransaction(
        tx,
        attempt.id,
        reviewedAt,
      );
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

  async recoverPendingProcessing() {
    const now = this.clock.now();
    const expiredAttemptIds: string[] = [];
    const attempts = await this.prisma.trainingAttempt.findMany({
      where: {
        status: {
          in: [...TRAINING_ACTIVE_ATTEMPT_STATUSES],
        },
      },
      include: {
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          include: {
            answer: {
              select: {
                id: true,
                status: true,
              },
            },
          },
        },
      },
    });

    for (const attempt of attempts) {
      await this.runSerializable(async (tx) => {
        await this.acquireAttemptLock(tx, attempt.id);

        for (const question of attempt.attemptQuestions) {
          const answer = question.answer;
          if (!answer) continue;

          if (
            answer.status === TrainingAnswerStatus.READY ||
            answer.status === TrainingAnswerStatus.TRANSCRIBING
          ) {
            await this.enqueueAnswerJobWithinTransaction(
              tx,
              TrainingJobKind.TRANSCRIBE_ANSWER,
              attempt.id,
              answer.id,
              now,
            );
          } else if (answer.status === TrainingAnswerStatus.EVALUATING) {
            await this.enqueueAnswerJobWithinTransaction(
              tx,
              TrainingJobKind.EVALUATE_ANSWER,
              attempt.id,
              answer.id,
              now,
            );
          }
        }

        if (now >= attempt.expiresAt) {
          await this.ensureTimeoutJobWithinTransaction(tx, attempt.id, now);
          expiredAttemptIds.push(attempt.id);
        }

        const hasProcessingAnswer = attempt.attemptQuestions.some(
          (question) =>
            question.answer?.status === TrainingAnswerStatus.READY ||
            question.answer?.status === TrainingAnswerStatus.TRANSCRIBING ||
            question.answer?.status === TrainingAnswerStatus.EVALUATING,
        );
        if (
          attempt.status === TrainingAttemptStatus.FINALIZING &&
          !hasProcessingAnswer
        ) {
          await this.enqueueFinalizeJobWithinTransaction(tx, attempt.id, now);
        }
      });
    }

    for (const attemptId of expiredAttemptIds) {
      await this.handleTimeout(attemptId, now, false);
    }
    await this.drainAttemptJobs(false);
  }

  private kickRecovery() {
    if (this.destroyed || this.kickQueued) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      void this.recoverPendingProcessing().catch((error) => {
        this.logger.error(
          'Training attempt recovery failed',
          error instanceof Error ? error.stack : String(error),
        );
      });
    });
  }

  private async drainAttemptJobs(propagateErrors: boolean) {
    if (this.drainPromise) {
      return this.drainPromise;
    }

    const drain = this.drainAttemptJobsLoop(propagateErrors).finally(() => {
      if (this.drainPromise === drain) {
        this.drainPromise = null;
      }
    });
    this.drainPromise = drain;
    return drain;
  }

  private async drainAttemptJobsLoop(propagateErrors: boolean) {
    while (!this.destroyed) {
      const job = await this.claimNextAttemptJob();
      if (!job) return;

      try {
        await this.processClaimedAttemptJob(job);
      } catch (error) {
        if (propagateErrors) {
          throw error;
        }
        this.logger.error(
          `Training attempt job ${job.id} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  private async claimNextAttemptJob(): Promise<ClaimedTrainingAttemptJob | null> {
    while (true) {
      const now = this.clock.now();
      const staleBefore = new Date(
        now.getTime() - TRAINING_ATTEMPT_JOB_LEASE_MS,
      );
      const candidate = await this.prisma.trainingJob.findFirst({
        where: {
          kind: {
            in: [...TRAINING_ATTEMPT_PROCESS_JOB_KINDS],
          },
          OR: [
            {
              status: TrainingJobStatus.PENDING,
              runAt: { lte: now },
            },
            {
              status: TrainingJobStatus.RUNNING,
              OR: [
                { heartbeatAt: null },
                { heartbeatAt: { lte: staleBefore } },
              ],
            },
          ],
        },
        orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          kind: true,
          payloadJson: true,
          attempts: true,
          maxAttempts: true,
        },
      });
      if (!candidate) return null;

      if (candidate.attempts >= candidate.maxAttempts) {
        await this.failExhaustedJob(candidate, now);
        continue;
      }

      const claimed = await this.prisma.trainingJob.updateMany({
        where: {
          id: candidate.id,
          attempts: candidate.attempts,
          OR: [
            {
              status: TrainingJobStatus.PENDING,
              runAt: { lte: now },
            },
            {
              status: TrainingJobStatus.RUNNING,
              OR: [
                { heartbeatAt: null },
                { heartbeatAt: { lte: staleBefore } },
              ],
            },
          ],
        },
        data: {
          status: TrainingJobStatus.RUNNING,
          attempts: { increment: 1 },
          lockOwner: this.workerId,
          lockedAt: now,
          heartbeatAt: now,
          finishedAt: null,
        },
      });
      if (claimed.count === 0) {
        continue;
      }

      return {
        ...candidate,
        attempts: candidate.attempts + 1,
      };
    }
  }

  private async processClaimedAttemptJob(job: ClaimedTrainingAttemptJob) {
    try {
      await this.withJobHeartbeat(job.id, async () => {
        switch (job.kind) {
          case TrainingJobKind.TRANSCRIBE_ANSWER:
            await this.processTranscriptionJob(job);
            return;
          case TrainingJobKind.EVALUATE_ANSWER:
            await this.processEvaluationJob(job);
            return;
          case TrainingJobKind.FINALIZE_ATTEMPT:
            await this.processFinalizationJob(job);
            return;
          case TrainingJobKind.EXPIRE_ATTEMPT:
            await this.processTimeoutJob(job);
            return;
          default:
            throw new Error(`Unsupported training attempt job kind: ${job.kind}`);
        }
      });
    } catch (error) {
      await this.failClaimedJob(job, error);
      throw error;
    }
  }

  private async withJobHeartbeat<T>(
    jobId: string,
    operation: () => Promise<T>,
  ) {
    const interval = setInterval(() => {
      if (this.destroyed) return;
      void this.prisma.trainingJob
        .updateMany({
          where: {
            id: jobId,
            status: TrainingJobStatus.RUNNING,
            lockOwner: this.workerId,
          },
          data: {
            heartbeatAt: this.clock.now(),
          },
        })
        .catch((error) => {
          this.logger.warn(
            `Training attempt job ${jobId} heartbeat failed: ${toSafeErrorMessage(error)}`,
          );
        });
    }, TRAINING_ATTEMPT_JOB_HEARTBEAT_MS);
    interval.unref();
    this.heartbeatIntervals.add(interval);

    try {
      return await operation();
    } finally {
      clearInterval(interval);
      this.heartbeatIntervals.delete(interval);
    }
  }

  private async processTranscriptionJob(job: ClaimedTrainingAttemptJob) {
    const payload = readAttemptJobPayload(job.payloadJson);
    if (!payload.answerId) {
      throw new Error('Transcription job payload has no answerId');
    }

    await this.prisma.trainingAnswer.updateMany({
      where: {
        id: payload.answerId,
        status: TrainingAnswerStatus.READY,
      },
      data: {
        status: TrainingAnswerStatus.TRANSCRIBING,
        processingStartedAt: this.clock.now(),
        errorCode: null,
        errorMessage: null,
      },
    });

    const context = await this.loadAnswerProcessingContext(payload.answerId);
    if (this.isTerminalAttemptStatus(context.attemptQuestion.attempt.status)) {
      await this.completeTerminalJob(job.id, payload.attemptId);
      return;
    }
    if (
      context.status === TrainingAnswerStatus.EVALUATING ||
      context.status === TrainingAnswerStatus.SCORED
    ) {
      const completedAt = this.clock.now();
      await this.runSerializable(async (tx) => {
        await this.acquireAttemptLock(tx, payload.attemptId);
        if (context.status === TrainingAnswerStatus.EVALUATING) {
          await this.enqueueAnswerJobWithinTransaction(
            tx,
            TrainingJobKind.EVALUATE_ANSWER,
            payload.attemptId,
            context.id,
            completedAt,
          );
        }
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
      });
      return;
    }

    const persistedTranscription =
      context.combinedTranscript !== null
        ? {
            transcript: context.combinedTranscript,
            language: context.normalizedLanguage ?? 'ru',
            provider: context.transcriptionProvider ?? 'recovered',
            model: context.transcriptionModel ?? 'recovered',
            requestId:
              context.transcriptionRequestId ??
              `recovered-transcription:${context.id}`,
          }
        : null;
    const transcription =
      persistedTranscription ??
      (await this.transcriptionProvider.transcribe({
        answerId: context.id,
        segments: context.voiceSegments.map((segment) => ({
          id: segment.id,
          segmentIndex: segment.segmentIndex,
          fakeTranscript: segment.fileUniqueId,
        })),
      }));
    const completedAt = this.clock.now();

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, payload.attemptId);
      if (!(await this.refreshOwnedJobWithinTransaction(tx, job.id))) {
        return;
      }
      const current = await tx.trainingAnswer.findUnique({
        where: { id: context.id },
        include: {
          attemptQuestion: {
            include: {
              attempt: true,
            },
          },
        },
      });
      if (!current) {
        throw new NotFoundException('Training answer not found');
      }
      if (this.isTerminalAttemptStatus(current.attemptQuestion.attempt.status)) {
        await this.closeAttemptJobsWithinTransaction(
          tx,
          payload.attemptId,
          completedAt,
        );
        return;
      }

      await tx.trainingAnswer.update({
        where: { id: current.id },
        data: {
          status: TrainingAnswerStatus.EVALUATING,
          combinedTranscript:
            current.combinedTranscript ?? transcription.transcript,
          normalizedLanguage:
            current.normalizedLanguage ?? transcription.language,
          transcriptionProvider:
            current.transcriptionProvider ?? transcription.provider,
          transcriptionModel:
            current.transcriptionModel ?? transcription.model,
          transcriptionRequestId:
            current.transcriptionRequestId ?? transcription.requestId,
        },
      });
      await this.enqueueAnswerJobWithinTransaction(
        tx,
        TrainingJobKind.EVALUATE_ANSWER,
        payload.attemptId,
        current.id,
        completedAt,
      );
      await this.completeJobWithinTransaction(tx, job.id, completedAt);
    });
  }

  private async processEvaluationJob(job: ClaimedTrainingAttemptJob) {
    const payload = readAttemptJobPayload(job.payloadJson);
    if (!payload.answerId) {
      throw new Error('Evaluation job payload has no answerId');
    }

    const context = await this.loadAnswerProcessingContext(payload.answerId);
    if (this.isTerminalAttemptStatus(context.attemptQuestion.attempt.status)) {
      await this.completeTerminalJob(job.id, payload.attemptId);
      return;
    }
    if (!context.combinedTranscript) {
      throw new Error('Evaluation job has no persisted transcript');
    }

    const existingEvaluation = await this.prisma.trainingAnswerEvaluation.findFirst({
      where: {
        answerId: context.id,
        evaluationNumber: 1,
      },
      include: {
        scoreComponents: true,
      },
    });
    if (
      context.status === TrainingAnswerStatus.SCORED &&
      existingEvaluation
    ) {
      const completedAt = this.clock.now();
      await this.runSerializable(async (tx) => {
        await this.acquireAttemptLock(tx, payload.attemptId);
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
      });
      return;
    }
    let evaluationResult:
      | {
          evaluation: Awaited<ReturnType<TrainingEvaluationProvider['evaluate']>>;
          score: ReturnType<typeof scoreTrainingEvaluation>;
        }
      | null = null;

    if (!existingEvaluation) {
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
        transcript: context.combinedTranscript,
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
      evaluationResult = {
        evaluation,
        score: scoreTrainingEvaluation({
          questionMaxScore: evaluationInput.questionMaxScore,
          criteria: evaluationInput.criteria,
          facts: evaluationInput.facts,
          evaluation,
        }),
      };
    }

    const completedAt = this.clock.now();
    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, payload.attemptId);
      if (!(await this.refreshOwnedJobWithinTransaction(tx, job.id))) {
        return;
      }
      let persistedEvaluation = await tx.trainingAnswerEvaluation.findFirst({
        where: {
          answerId: context.id,
          evaluationNumber: 1,
        },
        select: { id: true },
      });

      if (!persistedEvaluation) {
        if (!evaluationResult) {
          throw new Error('Recovered evaluation result is missing');
        }
        const { evaluation, score } = evaluationResult;
        persistedEvaluation = await tx.trainingAnswerEvaluation.create({
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
          select: { id: true },
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
        payload.attemptId,
        context.attemptQuestion.sequence,
        completedAt,
      );
      await this.completeJobWithinTransaction(tx, job.id, completedAt);
    });
  }

  private async processFinalizationJob(job: ClaimedTrainingAttemptJob) {
    const payload = readAttemptJobPayload(job.payloadJson);
    const completedAt = this.clock.now();

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, payload.attemptId);
      const finalized = await this.finalizeWithinTransaction(
        tx,
        payload.attemptId,
        completedAt,
      );
      if (finalized) {
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
        return;
      }

      await this.releaseJobWithinTransaction(
        tx,
        job.id,
        new Date(completedAt.getTime() + TRAINING_ATTEMPT_JOB_POLL_MS),
        'ATTEMPT_NOT_READY',
        'Training attempt still has unfinished questions',
      );
    });
  }

  private async processTimeoutJob(job: ClaimedTrainingAttemptJob) {
    const payload = readAttemptJobPayload(job.payloadJson);
    await this.handleTimeout(payload.attemptId, this.clock.now(), false);
  }

  private async loadAnswerProcessingContext(answerId: string) {
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
    return context;
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
      if (attempt) {
        await this.closeAttemptJobsWithinTransaction(tx, attempt.id, now);
      }
      return;
    }

    const timeExpired =
      now >= attempt.expiresAt || attempt.status === TrainingAttemptStatus.FINALIZING;
    if (completedSequence >= TRAINING_ATTEMPT_QUESTION_COUNT || timeExpired) {
      if (timeExpired) {
        await this.skipFutureQuestions(tx, attempt.id, completedSequence, now);
      }
      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: { status: TrainingAttemptStatus.FINALIZING },
      });
      await this.enqueueFinalizeJobWithinTransaction(tx, attempt.id, now);
      return;
    }

    const nextQuestion = attempt.attemptQuestions.find(
      (question) => question.sequence === completedSequence + 1,
    );
    if (!nextQuestion) {
      throw new ConflictException('Training attempt has no next question');
    }

    if (nextQuestion.status === TrainingAttemptQuestionStatus.PENDING) {
      await tx.trainingAttemptQuestion.update({
        where: { id: nextQuestion.id },
        data: {
          status: TrainingAttemptQuestionStatus.PRESENTED,
          presentedAt: now,
        },
      });
    } else if (
      nextQuestion.status !== TrainingAttemptQuestionStatus.PRESENTED &&
      nextQuestion.status !== TrainingAttemptQuestionStatus.COLLECTING
    ) {
      throw new ConflictException('Training follow-up question is not presentable');
    }
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
      sumTrainingScores(
        evaluations.map((evaluation) => evaluation.aiSuggestedScore),
      ),
    );
    const serverScore = clampTrainingAttemptScore(
      sumTrainingScores(evaluations.map((evaluation) => evaluation.serverScore)),
    );
    const requiresReview = evaluations.some(
      (evaluation) => evaluation.requiresReview,
    );
    const settings = this.readSettingsSnapshot(attempt.settingsSnapshotJson);
    const passStatus = requiresReview
      ? TrainingPassStatus.PENDING
      : trainingScoreMeetsThreshold(serverScore, settings.passScore)
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
    await tx.trainingJob.createMany({
      data: [
        {
          kind: TrainingJobKind.SEND_TELEGRAM_MESSAGE,
          status: TrainingJobStatus.PENDING,
          payloadJson: {
            operation: 'ATTEMPT_RESULT',
            attemptId: attempt.id,
          },
          idempotencyKey: `telegram:attempt-result:${attempt.id}`,
          runAt: new Date(completedAt.getTime() + 100),
          maxAttempts: 5,
        },
      ],
      skipDuplicates: true,
    });
    await this.closeAttemptJobsWithinTransaction(tx, attempt.id, completedAt);
    return true;
  }

  private async enqueueAnswerJobWithinTransaction(
    tx: Prisma.TransactionClient,
    kind:
      | typeof TrainingJobKind.TRANSCRIBE_ANSWER
      | typeof TrainingJobKind.EVALUATE_ANSWER,
    attemptId: string,
    answerId: string,
    runAt: Date,
  ) {
    const action =
      kind === TrainingJobKind.TRANSCRIBE_ANSWER ? 'transcribe' : 'evaluate';
    await tx.trainingJob.createMany({
      data: [
        {
          kind,
          status: TrainingJobStatus.PENDING,
          payloadJson: {
            attemptId,
            answerId,
          },
          idempotencyKey: `attempt:${attemptId}:answer:${answerId}:${action}`,
          runAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async enqueueFinalizeJobWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    runAt: Date,
  ) {
    await tx.trainingJob.createMany({
      data: [
        {
          kind: TrainingJobKind.FINALIZE_ATTEMPT,
          status: TrainingJobStatus.PENDING,
          payloadJson: { attemptId },
          idempotencyKey: `attempt:${attemptId}:finalize`,
          runAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async ensureTimeoutJobWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    runAt: Date,
  ) {
    await tx.trainingJob.createMany({
      data: [
        {
          kind: TrainingJobKind.EXPIRE_ATTEMPT,
          status: TrainingJobStatus.PENDING,
          payloadJson: { attemptId },
          idempotencyKey: `attempt:${attemptId}:timer:expire`,
          runAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async persistTimeoutIntentWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    nextRunAt: Date,
    persistedAt: Date,
    phase: string,
  ) {
    await this.ensureTimeoutJobWithinTransaction(tx, attemptId, nextRunAt);
    await tx.trainingJob.updateMany({
      where: {
        idempotencyKey: `attempt:${attemptId}:timer:expire`,
        status: {
          in: [
            TrainingJobStatus.PENDING,
            TrainingJobStatus.RUNNING,
            TrainingJobStatus.SUCCEEDED,
          ],
        },
      },
      data: {
        status: TrainingJobStatus.PENDING,
        payloadJson: {
          attemptId,
          timeoutIntentPersistedAt: persistedAt.toISOString(),
          phase,
        },
        runAt: nextRunAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        finishedAt: null,
      },
    });
  }

  private async completeTimeoutIntentWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    completedAt: Date,
  ) {
    await this.ensureTimeoutJobWithinTransaction(tx, attemptId, completedAt);
    await tx.trainingJob.updateMany({
      where: {
        idempotencyKey: `attempt:${attemptId}:timer:expire`,
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        payloadJson: {
          attemptId,
          timeoutIntentPersistedAt: completedAt.toISOString(),
          phase: 'APPLIED',
        },
        finishedAt: completedAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorDetailsJson: Prisma.JsonNull,
      },
    });
  }

  private async completeJobWithinTransaction(
    tx: Prisma.TransactionClient,
    jobId: string,
    completedAt: Date,
  ) {
    await tx.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt: completedAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        errorDetailsJson: Prisma.JsonNull,
      },
    });
  }

  private async refreshOwnedJobWithinTransaction(
    tx: Prisma.TransactionClient,
    jobId: string,
  ) {
    const owned = await tx.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: {
        heartbeatAt: this.clock.now(),
      },
    });
    return owned.count === 1;
  }

  private async releaseJobWithinTransaction(
    tx: Prisma.TransactionClient,
    jobId: string,
    runAt: Date,
    errorCode: string,
    errorMessage: string,
  ) {
    await tx.trainingJob.updateMany({
      where: {
        id: jobId,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        runAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
        errorDetailsJson: { retryable: true },
      },
    });
  }

  private async closeAttemptJobsWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    completedAt: Date,
    excludedJobId?: string,
  ) {
    await tx.trainingJob.updateMany({
      where: {
        idempotencyKey: {
          startsWith: `attempt:${attemptId}:`,
        },
        status: {
          in: [...TRAINING_ATTEMPT_CLOSABLE_JOB_STATUSES],
        },
        ...(excludedJobId ? { id: { not: excludedJobId } } : {}),
      },
      data: {
        status: TrainingJobStatus.SUCCEEDED,
        finishedAt: completedAt,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        errorDetailsJson: { terminalNoop: true },
      },
    });
  }

  private async completeTerminalJob(jobId: string, attemptId: string) {
    const completedAt = this.clock.now();
    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, attemptId);
      await this.closeAttemptJobsWithinTransaction(tx, attemptId, completedAt);
      await this.completeJobWithinTransaction(tx, jobId, completedAt);
    });
  }

  private async failClaimedJob(
    job: ClaimedTrainingAttemptJob,
    error: unknown,
    requireOwnership = true,
  ) {
    const payload = readAttemptJobPayload(job.payloadJson);
    const failedAt = this.clock.now();
    const message = toSafeErrorMessage(error);

    await this.runSerializable(async (tx) => {
      if (payload.attemptId) {
        await this.acquireAttemptLock(tx, payload.attemptId);
      }
      const failedJob = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          ...(requireOwnership
            ? {
                status: TrainingJobStatus.RUNNING,
                lockOwner: this.workerId,
              }
            : {
                attempts: job.attempts,
              }),
        },
        data: {
          status: TrainingJobStatus.DEAD,
          finishedAt: failedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: 'ATTEMPT_JOB_FAILED',
          lastErrorMessage: message,
          errorDetailsJson: { retryable: false },
        },
      });
      if (failedJob.count === 0) {
        return;
      }
      if (payload.answerId) {
        await tx.trainingAnswer.updateMany({
          where: { id: payload.answerId },
          data: {
            status: TrainingAnswerStatus.FAILED,
            processingFinishedAt: failedAt,
            errorCode: 'FAKE_PROVIDER_FAILED',
            errorMessage: message,
          },
        });
      }
      if (payload.attemptId) {
        await tx.trainingAttempt.updateMany({
          where: {
            id: payload.attemptId,
            status: {
              in: [...TRAINING_ACTIVE_ATTEMPT_STATUSES],
            },
          },
          data: {
            status: TrainingAttemptStatus.TECHNICAL_FAILURE,
            completedAt: failedAt,
            passStatus: TrainingPassStatus.PENDING,
          },
        });
        await this.closeAttemptJobsWithinTransaction(
          tx,
          payload.attemptId,
          failedAt,
          job.id,
        );
      }
    });
  }

  private async failExhaustedJob(
    job: ClaimedTrainingAttemptJob,
    failedAt: Date,
  ) {
    await this.failClaimedJob(
      job,
      new Error(
        `Training attempt job exhausted ${job.maxAttempts} recovery attempts at ${failedAt.toISOString()}`,
      ),
      false,
    );
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

function readAttemptJobPayload(value: Prisma.JsonValue) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.attemptId !== 'string'
  ) {
    throw new Error('Training attempt job payload has no attemptId');
  }

  return {
    attemptId: value.attemptId,
    answerId: typeof value.answerId === 'string' ? value.answerId : null,
  };
}

function toSafeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : 'Training attempt job failed')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 2_000);
}

export const TRAINING_ATTEMPT_SCORE_MAXIMUM = TRAINING_TOTAL_MAX_SCORE;

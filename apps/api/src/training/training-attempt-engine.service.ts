import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
  TrainingProviderKind,
  TrainingProviderRunStatus,
  TrainingProviderRunType,
  TrainingProjectAudienceMode,
  TrainingProjectStatus,
  TrainingQuestionType,
  TrainingReviewStatus,
  TrainingVersionStatus,
} from '@prisma/client';
import type { TrainingAttemptSettingsSnapshot } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import { TrainingAudioConfig } from './audio/training-audio.config';
import { TrainingAudioError } from './audio/training-audio.error';
import {
  TrainingConfigService,
  TrainingFeatureDisabledAfterClaimError,
} from './training.config';
import {
  TRAINING_ATTEMPT_CLOCK,
  TRAINING_ATTEMPT_JOB_PROCESSOR_ENABLED,
  TRAINING_EVALUATION_PROVIDER,
  TRAINING_QUESTION_SELECTOR,
  TRAINING_TRANSCRIPTION_PROVIDER,
  type TrainingAttemptClock,
  type TrainingEvaluationInput,
  type TrainingEvaluationProvider,
  type TrainingQuestionSelector,
  type TrainingTranscriptionProvider,
  type TrainingTranscriptionResult,
} from './training-attempt.providers';
import { TrainingOpenAiConfig } from './openai/training-openai.config';
import { TrainingOpenAiRequestError } from './openai/training-openai.http';
import {
  TRAINING_EVALUATION_PROMPT_VERSION,
  TRAINING_EVALUATION_SCHEMA_VERSION,
} from './openai/training-openai-evaluation.provider';
import { buildSafeTrainingVocabulary } from './openai/training-openai-vocabulary';
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
import { parseTrainingReviewIdempotencyKey } from './training-review-idempotency';
import { TrainingPolicyService } from './training-policy.service';
import {
  acquireTrainingProjectAudienceLock,
  acquireTrainingUserProjectLock,
  activeTrainingAssignmentSelect,
  resolveTrainingAttemptAssignmentId,
} from './training-project-access';
import {
  formatTrainingErrorForLog,
  readTrainingCorrelationId,
  resolveTrainingCorrelationId,
  safeTrainingFailureMessage,
  writeSafeTrainingLog,
} from './training-safe-log';
import { TrainingWorkerHeartbeatService } from './training-worker-heartbeat.service';
import { enqueueAttemptTelegramOutboxEvent } from './telegram/training-telegram-outbox';

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

class TrainingAttemptWorkerShutdownError extends Error {
  constructor() {
    super('Training attempt worker is shutting down');
    this.name = 'TrainingAttemptWorkerShutdownError';
  }
}

export type ConfirmTrainingAttemptStartCommand = {
  userId: string;
  projectId: string;
  confirmed: boolean;
  correlationId?: string;
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
  correlationId?: string;
};

export type FinishTrainingAnswerCommand = {
  attemptId: string;
  attemptQuestionId: string;
  receivedAt?: Date;
  correlationId?: string;
};

export type RefundTechnicalTrainingAttemptCommand = {
  attemptId: string;
  actorUserId: string;
  reason: string;
};

export type TerminalizeTelegramDeliveryFailureCommand = {
  attemptId: string;
  attemptQuestionId: string;
  failedJobId: string;
  errorCode: string;
  correlationId?: string;
};

export type ReviewTrainingAttemptCommand = {
  attemptId: string;
  reviewerId: string;
  idempotencyKey: string;
  decision: 'APPROVED' | 'OVERRIDDEN';
  adminScore?: Prisma.Decimal | number | string;
  comment: string;
  unsupportedClaimsDecisions?: unknown;
};

export type ReprocessTrainingAnswerCommand = {
  answerId: string;
  reviewerId: string;
  comment: string;
};

type ClaimedTrainingAttemptJob = {
  id: string;
  kind: TrainingJobKind;
  status: TrainingJobStatus;
  payloadJson: Prisma.JsonValue;
  attempts: number;
  maxAttempts: number;
  lockOwner: string | null;
  lockedAt: Date | null;
  heartbeatAt: Date | null;
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
    @Optional()
    private readonly audioConfig?: TrainingAudioConfig,
    @Optional()
    private readonly openAiConfig?: TrainingOpenAiConfig,
    @Optional()
    @Inject(TRAINING_ATTEMPT_JOB_PROCESSOR_ENABLED)
    private readonly jobProcessorEnabled?: boolean,
    @Optional()
    private readonly trainingConfig?: TrainingConfigService,
    @Optional()
    private readonly trainingPolicy?: TrainingPolicyService,
    @Optional()
    private readonly workerHeartbeat?: TrainingWorkerHeartbeatService,
  ) {}

  onModuleInit() {
    this.destroyed = false;
    if (
      this.jobProcessorEnabled === false ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    void this.workerHeartbeat
      ?.register('attempt', this.workerId)
      .catch(() => undefined);
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
    this.trainingConfig?.assertEnabled();
    if (!command.confirmed) {
      throw new BadRequestException('Training attempt start must be explicitly confirmed');
    }

    const startedAt = this.clock.now();
    const correlationId =
      readTrainingCorrelationId(command.correlationId) ??
      `training-start:${command.projectId}`;

    try {
      const attemptId = await this.runSerializable(async (tx) => {
        await this.acquireUserProjectLock(tx, command.userId, command.projectId);
        await this.trainingPolicy?.assertCurrentPolicyAccepted(
          tx,
          command.userId,
          startedAt,
        );

        const project = await tx.trainingProject.findUnique({
          where: { id: command.projectId },
          include: {
            assignments: activeTrainingAssignmentSelect(command.userId),
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
        const assignmentId = resolveTrainingAttemptAssignmentId(project);
        if (
          project.audienceMode ===
            TrainingProjectAudienceMode.ASSIGNED_ONLY &&
          !assignmentId
        ) {
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
            assignmentId,
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
                correlationId,
              },
              idempotencyKey: `attempt:${attempt.id}:timer:warning:${warningSeconds}`,
              runAt: new Date(expiresAt.getTime() - warningSeconds * 1_000),
            })),
            {
              kind: TrainingJobKind.EXPIRE_ATTEMPT,
              status: TrainingJobStatus.PENDING,
              payloadJson: { attemptId: attempt.id, correlationId },
              idempotencyKey: `attempt:${attempt.id}:timer:expire`,
              runAt: expiresAt,
            },
          ],
          skipDuplicates: true,
        });
        const presentedQuestion =
          await tx.trainingAttemptQuestion.findFirstOrThrow({
            where: {
              attemptId: attempt.id,
              sequence: 1,
            },
            select: { id: true },
          });
        await enqueueAttemptTelegramOutboxEvent(tx, {
          eventType: 'ATTEMPT_QUESTION',
          attemptId: attempt.id,
          attemptQuestionId: presentedQuestion.id,
          idempotencyKey: `telegram:attempt:${attempt.id}:question:${presentedQuestion.id}`,
          runAt: startedAt,
          correlationId,
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
    const correlationId =
      readTrainingCorrelationId(command.correlationId) ??
      `training-voice:${command.updateId.toString()}`;

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
      if (
        currentQuestion.answer?.voiceSegments.some(
          (segment) => segment.fileUniqueId === fileUniqueId,
        )
      ) {
        return {
          autoFinish: false,
          duplicate: true,
          attemptQuestionId: currentQuestion.id,
        };
      }
      if (this.audioConfig) {
        const existingSegments =
          currentQuestion.answer?.voiceSegments ?? [];
        if (existingSegments.length >= this.audioConfig.maxSegments) {
          throw new BadRequestException(
            'Training answer segment limit is exceeded',
          );
        }
        if (
          command.sizeBytes !== undefined &&
          command.sizeBytes > BigInt(this.audioConfig.maxSegmentBytes)
        ) {
          throw new BadRequestException(
            'Training voice segment size limit is exceeded',
          );
        }
        const declaredAnswerBytes = existingSegments.reduce(
          (total, segment) => total + (segment.sizeBytes ?? 0n),
          command.sizeBytes ?? 0n,
        );
        if (declaredAnswerBytes > BigInt(this.audioConfig.maxAnswerBytes)) {
          throw new BadRequestException(
            'Training answer size limit is exceeded',
          );
        }
        const declaredAnswerDurationSeconds = existingSegments.reduce(
          (total, segment) => total + (segment.durationSeconds ?? 0),
          command.durationSeconds ?? 0,
        );
        if (
          declaredAnswerDurationSeconds >
          this.audioConfig.maxAnswerDurationSeconds
        ) {
          throw new BadRequestException(
            'Training answer duration limit is exceeded',
          );
        }
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

      const segment = await tx.trainingVoiceSegment.create({
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
      if (this.audioConfig) {
        await tx.trainingJob.createMany({
          data: [
            {
              kind: TrainingJobKind.TELEGRAM_DOWNLOAD_SEGMENT,
              status: TrainingJobStatus.PENDING,
              payloadJson: {
                attemptId: attempt.id,
                answerId: answer.id,
                segmentId: segment.id,
                correlationId,
              },
              idempotencyKey: `attempt:${attempt.id}:answer:${answer.id}:segment:${segment.id}:download`,
              runAt: receivedAt,
              maxAttempts: 5,
            },
          ],
          skipDuplicates: true,
        });
      }

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
        correlationId,
      });
    }
    return this.getAttempt(command.attemptId);
  }

  async finishAnswer(command: FinishTrainingAnswerCommand) {
    const receivedAt = command.receivedAt ?? this.clock.now();
    if (
      !(receivedAt instanceof Date) ||
      !Number.isFinite(receivedAt.getTime())
    ) {
      throw new BadRequestException(
        'Training answer finish ingress time is invalid',
      );
    }
    const correlationId =
      readTrainingCorrelationId(command.correlationId) ??
      `training-attempt:${command.attemptId}`;
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

      const finishedAt = receivedAt;
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
          : this.audioConfig
            ? TrainingJobKind.ASSEMBLE_ANSWER_AUDIO
            : TrainingJobKind.TRANSCRIBE_ANSWER,
        attempt.id,
        answer.id,
        finishedAt,
        TrainingProviderRunType.PRIMARY,
        null,
        correlationId,
      );
      await enqueueAttemptTelegramOutboxEvent(tx, {
        eventType: 'ANSWER_ACCEPTED',
        attemptId: attempt.id,
        attemptQuestionId: targetQuestion.id,
        idempotencyKey: `telegram:attempt:${attempt.id}:answer-accepted:${targetQuestion.id}`,
        runAt: finishedAt,
        correlationId,
      });
      return answer.id;
    });

    if (
      answerId &&
      !this.audioConfig &&
      this.jobProcessorEnabled !== false
    ) {
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
          answer.status === TrainingAnswerStatus.DOWNLOADING ||
          answer.status === TrainingAnswerStatus.TRANSCRIBING ||
          answer.status === TrainingAnswerStatus.EVALUATING);

      if (answerIsProcessing) {
        await this.enqueueAnswerJobWithinTransaction(
          tx,
          this.getAnswerProcessingJobKind(answer),
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
          this.audioConfig
            ? TrainingJobKind.ASSEMBLE_ANSWER_AUDIO
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

    if (
      result.shouldDrain &&
      drainJobs &&
      this.jobProcessorEnabled !== false &&
      !this.drainPromise
    ) {
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
    if (this.jobProcessorEnabled !== false) {
      await this.drainAttemptJobs(true);
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

  async terminalizeTelegramDeliveryFailure(
    command: TerminalizeTelegramDeliveryFailureCommand,
  ) {
    const errorCode = command.errorCode.trim();
    if (
      !/^[A-Z0-9_]{3,120}$/u.test(errorCode) ||
      !command.attemptId ||
      !command.attemptQuestionId ||
      !command.failedJobId
    ) {
      throw new BadRequestException(
        'Telegram delivery failure command is invalid',
      );
    }
    const failedAt = this.clock.now();
    const correlationId =
      readTrainingCorrelationId(command.correlationId) ??
      `training-attempt:${command.attemptId}`;

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);
      const failedJob = await tx.trainingJob.findUnique({
        where: { id: command.failedJobId },
        select: {
          id: true,
          kind: true,
          status: true,
          payloadJson: true,
        },
      });
      if (
        !failedJob ||
        failedJob.kind !== TrainingJobKind.SEND_TELEGRAM_MESSAGE ||
        failedJob.status !== TrainingJobStatus.DEAD
      ) {
        throw new ConflictException(
          'Critical Telegram delivery job is not dead',
        );
      }
      const delivery = readTelegramAttemptDeliveryPayload(
        failedJob.payloadJson,
      );
      if (delivery?.eventType === 'TECHNICAL_FAILURE') {
        return;
      }
      if (
        delivery?.eventType !== 'ATTEMPT_QUESTION' ||
        delivery.attemptId !== command.attemptId ||
        delivery.attemptQuestionId !== command.attemptQuestionId
      ) {
        throw new ConflictException(
          'Telegram delivery job does not match the current attempt question',
        );
      }

      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: command.attemptId },
        include: {
          attemptQuestions: {
            orderBy: { sequence: 'asc' },
            select: {
              id: true,
              sequence: true,
              status: true,
            },
          },
        },
      });
      if (!attempt) {
        throw new NotFoundException('Training attempt not found');
      }
      if (this.isTerminalAttemptStatus(attempt.status)) {
        return;
      }
      const currentQuestion = this.findCurrentQuestion(
        attempt.attemptQuestions,
      );
      if (currentQuestion?.id !== command.attemptQuestionId) {
        throw new ConflictException(
          'Telegram delivery failure is not for the current attempt question',
        );
      }

      await tx.trainingAttempt.update({
        where: { id: attempt.id },
        data: {
          status: TrainingAttemptStatus.TECHNICAL_FAILURE,
          isConsumed: false,
          completedAt: failedAt,
          passStatus: TrainingPassStatus.PENDING,
        },
      });
      await this.closeAttemptJobsWithinTransaction(
        tx,
        attempt.id,
        failedAt,
      );
      await tx.auditLog.create({
        data: {
          action: 'training.attempt.automatic_refund',
          entityType: 'training_attempt',
          entityId: attempt.id,
          metadata: {
            reason: 'telegram_question_delivery_failed',
            attemptQuestionId: command.attemptQuestionId,
            failedJobId: command.failedJobId,
            errorCode,
          },
        },
      });
      await enqueueAttemptTelegramOutboxEvent(tx, {
        eventType: 'TECHNICAL_FAILURE',
        attemptId: attempt.id,
        idempotencyKey: `telegram:attempt-technical-failure:${attempt.id}`,
        runAt: failedAt,
        correlationId,
      });
    });

    return this.getAttempt(command.attemptId);
  }

  async reviewAttempt(command: ReviewTrainingAttemptCommand) {
    const idempotencyKey = parseTrainingReviewIdempotencyKey(
      command.idempotencyKey,
    );
    const comment = command.comment
      .normalize('NFC')
      .replace(/\r\n?/gu, '\n')
      .trim();
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
    const suppliedUnsupportedDecisions =
      parseUnsupportedClaimDecisionPayload(
        command.unsupportedClaimsDecisions,
      );
    const canonicalAdminScore =
      command.decision === 'OVERRIDDEN'
        ? clampTrainingAttemptScore(command.adminScore!).toFixed(2)
        : null;
    const requestPayloadHash = hashProviderInput({
      decision: command.decision,
      adminScore: canonicalAdminScore,
      comment,
      unsupportedClaimsDecisions: [
        ...suppliedUnsupportedDecisions,
      ].sort((left, right) =>
        left.componentKey.localeCompare(right.componentKey, 'en'),
      ),
    });

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, command.attemptId);
      const existingReview =
        await tx.trainingResultReview.findFirst({
          where: {
            attemptId: command.attemptId,
            reviewerId: command.reviewerId,
            idempotencyKey,
          },
          select: {
            requestPayloadHash: true,
          },
        });
      if (existingReview) {
        if (
          existingReview.requestPayloadHash !== requestPayloadHash
        ) {
          throw new ConflictException(
            'Idempotency-Key was already used with a different review payload',
          );
        }
        return;
      }
      const attempt = await tx.trainingAttempt.findUnique({
        where: { id: command.attemptId },
        include: {
          reviews: {
            orderBy: { reviewNumber: 'desc' },
            take: 1,
          },
          attemptQuestions: {
            include: {
              answer: {
                include: {
                  activeEvaluation: {
                    include: {
                      scoreComponents: {
                        where: {
                          factVerdict: 'UNSUPPORTED',
                        },
                      },
                    },
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
      if (
        attempt.status !== TrainingAttemptStatus.COMPLETED &&
        attempt.status !== TrainingAttemptStatus.REQUIRES_REVIEW
      ) {
        throw new ConflictException('Training attempt is not reviewable');
      }
      if (attempt.serverScore === null) {
        throw new ConflictException('Training attempt has no server score');
      }

      const unsupportedComponents = attempt.attemptQuestions.flatMap(
        (question) =>
          question.answer?.activeEvaluation?.scoreComponents ?? [],
      );
      const unsupportedDecisions = parseUnsupportedClaimDecisions(
        suppliedUnsupportedDecisions,
        unsupportedComponents.map((component) => component.componentKey),
      );
      const incorrectUnsupportedCount = unsupportedDecisions.filter(
        (decision) => decision.decision === 'INCORRECT',
      ).length;
      const serverScore = clampTrainingAttemptScore(
        canonicalTrainingScore(attempt.serverScore).sub(
          canonicalTrainingScore(5).mul(incorrectUnsupportedCount),
        ),
      );
      const adminScore =
        command.decision === 'OVERRIDDEN'
          ? clampTrainingAttemptScore(canonicalAdminScore!)
          : null;
      const finalScore = adminScore ?? serverScore;
      const settings = this.readSettingsSnapshot(attempt.settingsSnapshotJson);
      const reviewStatus =
        command.decision === 'OVERRIDDEN'
          ? TrainingReviewStatus.OVERRIDDEN
          : TrainingReviewStatus.APPROVED;
      const reviewedAt = this.clock.now();
      const reviewNumber = (attempt.reviews[0]?.reviewNumber ?? 0) + 1;

      await tx.trainingResultReview.create({
        data: {
          attemptId: attempt.id,
          reviewerId: command.reviewerId,
          idempotencyKey,
          requestPayloadHash,
          reviewNumber,
          previousFinalScore: attempt.finalScore,
          adminScore,
          finalScore,
          decision: reviewStatus,
          comment,
          unsupportedClaimsDecisionsJson:
            unsupportedDecisions,
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
      await enqueueAttemptTelegramOutboxEvent(tx, {
        eventType: 'ATTEMPT_RESULT',
        attemptId: attempt.id,
        idempotencyKey: `telegram:attempt-result:${attempt.id}:review:${reviewNumber}`,
        runAt: reviewedAt,
      });
      await tx.auditLog.create({
        data: {
          actorUserId: command.reviewerId,
          action: 'training.attempt.review',
          entityType: 'training_attempt',
          entityId: attempt.id,
          metadata: {
            decision: reviewStatus,
            finalScore: finalScore.toString(),
            incorrectUnsupportedCount,
            unsupportedClaimsDecisions: unsupportedDecisions,
          },
        },
      });
    });

    return this.getReviewDetails(command.attemptId);
  }

  async reprocessTranscription(command: ReprocessTrainingAnswerCommand) {
    return this.enqueueAnswerReprocessing(
      command,
      TrainingJobKind.TRANSCRIBE_ANSWER,
      'training.answer.reprocess_transcription',
    );
  }

  async reprocessEvaluation(command: ReprocessTrainingAnswerCommand) {
    return this.enqueueAnswerReprocessing(
      command,
      TrainingJobKind.EVALUATE_ANSWER,
      'training.answer.reprocess_evaluation',
    );
  }

  private async enqueueAnswerReprocessing(
    command: ReprocessTrainingAnswerCommand,
    kind:
      | typeof TrainingJobKind.TRANSCRIBE_ANSWER
      | typeof TrainingJobKind.EVALUATE_ANSWER,
    auditAction: string,
  ) {
    const comment = command.comment.trim();
    if (!comment || comment.length > 2_000) {
      throw new BadRequestException('Reprocessing comment is required');
    }
    const runNonce = randomUUID();
    const requestedAt = this.clock.now();

    const result = await this.runSerializable(async (tx) => {
      const answerReference = await tx.trainingAnswer.findUnique({
        where: { id: command.answerId },
        select: {
          id: true,
          attemptQuestion: {
            select: { attemptId: true },
          },
        },
      });
      if (!answerReference) {
        throw new NotFoundException('Training answer not found');
      }
      await this.acquireAttemptLock(
        tx,
        answerReference.attemptQuestion.attemptId,
      );
      const answer = await tx.trainingAnswer.findUnique({
        where: { id: command.answerId },
        include: {
          attemptQuestion: {
            include: {
              attempt: true,
            },
          },
        },
      });
      if (!answer) {
        throw new NotFoundException('Training answer not found');
      }
      const attempt = answer.attemptQuestion.attempt;
      if (
        attempt.status !== TrainingAttemptStatus.COMPLETED &&
        attempt.status !== TrainingAttemptStatus.REQUIRES_REVIEW &&
        attempt.status !== TrainingAttemptStatus.TECHNICAL_FAILURE
      ) {
        throw new ConflictException(
          'Only a terminal training attempt can be reprocessed',
        );
      }
      if (!attempt.isConsumed) {
        throw new ConflictException(
          'A refunded training attempt cannot be reprocessed',
        );
      }
      if (
        kind === TrainingJobKind.TRANSCRIBE_ANSWER &&
        this.openAiConfig?.providerMode === 'real' &&
        !answer.mergedAudioFileId
      ) {
        throw new ConflictException(
          'Training answer has no normalized audio for reprocessing',
        );
      }
      if (
        kind === TrainingJobKind.EVALUATE_ANSWER &&
        !answer.combinedTranscript
      ) {
        throw new ConflictException(
          'Training answer has no transcript for reprocessing',
        );
      }
      const activeReprocessingJob = await tx.trainingJob.findFirst({
        where: {
          idempotencyKey: {
            startsWith: `attempt:${attempt.id}:answer:${answer.id}:`,
          },
          status: {
            in: [TrainingJobStatus.PENDING, TrainingJobStatus.RUNNING],
          },
        },
        select: { id: true },
      });
      if (activeReprocessingJob) {
        throw new ConflictException(
          'Training answer already has active processing',
        );
      }
      await this.enqueueAnswerJobWithinTransaction(
        tx,
        kind,
        attempt.id,
        answer.id,
        requestedAt,
        TrainingProviderRunType.REPROCESS,
        runNonce,
      );
      await tx.auditLog.create({
        data: {
          actorUserId: command.reviewerId,
          action: auditAction,
          entityType: 'training_answer',
          entityId: answer.id,
          metadata: {
            attemptId: attempt.id,
            comment,
            runNonce,
          },
        },
      });
      return {
        answerId: answer.id,
        attemptId: attempt.id,
        runNonce,
        status: 'queued',
      };
    });

    return result;
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

  async getReviewDetails(attemptId: string) {
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        aiScore: true,
        serverScore: true,
        adminScore: true,
        finalScore: true,
        reviewStatus: true,
        passStatus: true,
        user: {
          select: { id: true, email: true, name: true },
        },
        project: {
          select: { id: true, slug: true, title: true },
        },
        reviews: {
          orderBy: { reviewNumber: 'asc' },
          include: {
            reviewer: {
              select: { id: true, email: true, name: true },
            },
          },
        },
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            status: true,
            question: {
              select: {
                id: true,
                type: true,
                text: true,
                maxScore: true,
              },
            },
            answer: {
              select: {
                id: true,
                status: true,
                combinedTranscript: true,
                normalizedLanguage: true,
                activeTranscriptionId: true,
                activeEvaluationId: true,
                acousticMetricsJson: true,
                errorCode: true,
                errorMessage: true,
                transcriptions: {
                  orderBy: { transcriptionNumber: 'asc' },
                  include: {
                    providerRun: {
                      select: {
                        id: true,
                        runType: true,
                        status: true,
                        requestedModelId: true,
                        actualModelId: true,
                        requestId: true,
                        retryCount: true,
                        ambiguousOutcome: true,
                        errorCode: true,
                        startedAt: true,
                        completedAt: true,
                      },
                    },
                  },
                },
                evaluations: {
                  orderBy: { evaluationNumber: 'asc' },
                  include: {
                    scoreComponents: {
                      orderBy: { componentKey: 'asc' },
                    },
                    providerRun: {
                      select: {
                        id: true,
                        runType: true,
                        status: true,
                        requestedModelId: true,
                        actualModelId: true,
                        reasoningEffort: true,
                        requestId: true,
                        retryCount: true,
                        ambiguousOutcome: true,
                        errorCode: true,
                        startedAt: true,
                        completedAt: true,
                      },
                    },
                  },
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
                mergedAudioFileId: true,
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
            answer.status === TrainingAnswerStatus.DOWNLOADING ||
            answer.status === TrainingAnswerStatus.TRANSCRIBING
          ) {
            await this.enqueueAnswerJobWithinTransaction(
              tx,
              this.getAnswerProcessingJobKind(answer),
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
            question.answer?.status === TrainingAnswerStatus.COLLECTING ||
            question.answer?.status === TrainingAnswerStatus.READY ||
            question.answer?.status === TrainingAnswerStatus.DOWNLOADING ||
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
    if (
      this.destroyed ||
      this.kickQueued ||
      this.trainingConfig?.isEnabled() === false
    ) {
      return;
    }
    void this.workerHeartbeat?.touch(this.workerId).catch(() => undefined);
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      void this.recoverPendingProcessing().catch((error) => {
        this.logger.error(
          `Training attempt recovery failed: ${formatTrainingErrorForLog(error)}`,
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
      if (this.trainingConfig?.isEnabled() === false) return;
      const job = await this.claimNextAttemptJob();
      if (!job) return;

      try {
        if (this.destroyed) {
          await this.releaseJobAfterShutdown(job);
          return;
        }
        await this.processClaimedAttemptJob(job);
      } catch (error) {
        if (propagateErrors) {
          throw error;
        }
        this.logger.error(
          `Training attempt job ${job.id} failed: ${formatTrainingErrorForLog(error)}`,
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
          status: true,
          payloadJson: true,
          attempts: true,
          maxAttempts: true,
          lockOwner: true,
          lockedAt: true,
          heartbeatAt: true,
        },
      });
      if (this.destroyed) return null;
      if (!candidate) return null;

      if (candidate.attempts >= candidate.maxAttempts) {
        await this.failExhaustedJob(candidate, now);
        if (this.destroyed) return null;
        continue;
      }
      if (this.destroyed) return null;
      const candidateSnapshot = { ...candidate };
      const claimedAttempts = candidate.attempts + 1;

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
      if (this.destroyed) {
        await this.releaseJobAfterShutdown({
          ...candidateSnapshot,
          status: TrainingJobStatus.RUNNING,
          attempts: claimedAttempts,
          lockOwner: this.workerId,
          lockedAt: now,
          heartbeatAt: now,
        });
        return null;
      }

      return {
        ...candidateSnapshot,
        status: TrainingJobStatus.RUNNING,
        attempts: claimedAttempts,
        lockOwner: this.workerId,
        lockedAt: now,
        heartbeatAt: now,
      };
    }
  }

  private async processClaimedAttemptJob(job: ClaimedTrainingAttemptJob) {
    try {
      if (this.destroyed) {
        await this.releaseJobAfterShutdown(job);
        return;
      }
      await this.withJobHeartbeat(job.id, async () => {
        this.assertRuntimeEnabled();
        const payload = readAttemptJobPayload(job.payloadJson);
        writeSafeTrainingLog(
          this.logger,
          'log',
          'training.attempt.job.started',
          {
            correlationId: payload.correlationId,
            jobId: job.id,
            attemptId: payload.attemptId,
            answerId: payload.answerId,
            status: job.kind,
            workerKind: 'attempt',
          },
        );
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
      if (error instanceof TrainingAttemptWorkerShutdownError) {
        await this.releaseJobAfterShutdown(job);
        return;
      }
      if (error instanceof TrainingFeatureDisabledAfterClaimError) {
        await this.releaseJobAfterFeatureDisable(job);
        return;
      }
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

    if (payload.runType === TrainingProviderRunType.PRIMARY) {
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
    }

    const context = await this.loadAnswerProcessingContext(payload.answerId);
    if (
      payload.runType === TrainingProviderRunType.PRIMARY &&
      this.isTerminalAttemptStatus(context.attemptQuestion.attempt.status)
    ) {
      await this.completeTerminalJob(job.id, payload.attemptId);
      return;
    }
    if (
      payload.runType !== TrainingProviderRunType.PRIMARY &&
      (!this.isTerminalAttemptStatus(
        context.attemptQuestion.attempt.status,
      ) ||
        !context.attemptQuestion.attempt.isConsumed)
    ) {
      await this.completeTerminalJob(job.id, payload.attemptId);
      return;
    }
    if (
      this.audioConfig &&
      (!context.mergedAudioFile ||
        !context.mergedAudioFile.bucket ||
        !context.mergedAudioFile.key ||
        context.mergedAudioFile.url !== null ||
        !context.mergedAudioFile.mimeType ||
        context.mergedAudioFile.sizeBytes === null ||
        !context.mergedAudioFile.checksum ||
        context.mergedAudioDurationMilliseconds === null)
    ) {
      throw new TrainingAudioError('AUDIO_METADATA_INVALID', false);
    }
    if (
      payload.runType === TrainingProviderRunType.PRIMARY &&
      (context.status === TrainingAnswerStatus.EVALUATING ||
        context.status === TrainingAnswerStatus.SCORED)
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
            payload.runType,
            payload.runNonce,
            payload.correlationId,
          );
        }
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
      });
      return;
    }

    const persistedTranscription: TrainingTranscriptionResult | null =
      payload.runType === TrainingProviderRunType.PRIMARY &&
      context.combinedTranscript !== null
        ? {
            transcript: context.combinedTranscript,
            language: context.normalizedLanguage ?? 'ru',
            provider: context.transcriptionProvider ?? 'recovered',
            requestedModelId: context.transcriptionModel ?? 'recovered',
            actualModelId: context.transcriptionModel ?? null,
            requestId:
              context.transcriptionRequestId ??
              `recovered-transcription:${context.id}`,
            wordCount: countTranscriptWords(context.combinedTranscript),
          }
        : null;
    const approvedVocabulary = buildApprovedVocabulary(context);
    let providerRunId: string | null = null;
    let transcription = persistedTranscription;

    if (!transcription) {
      const requestedModelId = this.resolveTranscriptionModel(payload.runType);
      this.assertRuntimeEnabled();
      const providerRun = await this.prepareProviderRun({
        jobId: job.id,
        answerId: context.id,
        kind: TrainingProviderKind.TRANSCRIPTION,
        runType: payload.runType,
        requestedModelId,
        sourceFileId: context.mergedAudioFile?.id ?? null,
        sourceChecksum: context.mergedAudioFile?.checksum ?? null,
        inputHash: hashProviderInput({
          answerId: context.id,
          sourceChecksum: context.mergedAudioFile?.checksum ?? null,
          vocabularyHash: approvedVocabulary.hash,
          runType: payload.runType,
        }),
        inputMetadata: {
          sourceFileId: context.mergedAudioFile?.id ?? null,
          sizeBytes:
            context.mergedAudioFile?.sizeBytes === null ||
            context.mergedAudioFile?.sizeBytes === undefined
              ? null
              : Number(context.mergedAudioFile.sizeBytes),
          vocabularyVersion: approvedVocabulary.version,
          vocabularyHash: approvedVocabulary.hash,
          ...(payload.correlationId
            ? { correlationId: payload.correlationId }
            : {}),
        },
      });
      providerRunId = providerRun?.id ?? null;

      if (providerRun?.status === TrainingProviderRunStatus.SUCCEEDED) {
        const recovered =
          await this.prisma.trainingAnswerTranscription.findUnique({
            where: { providerRunId: providerRun.id },
          });
        if (!recovered) {
          throw new Error('Succeeded transcription provider run has no result');
        }
        transcription = {
          transcript: recovered.transcript,
          language: recovered.language,
          provider: 'openai',
          requestedModelId: providerRun.requestedModelId,
          actualModelId: providerRun.actualModelId,
          requestId: providerRun.requestId,
          wordCount: recovered.wordCount,
          usage: asRecord(providerRun.providerUsageJson),
          latencyMs: providerRun.latencyMs ?? undefined,
          retryCount: providerRun.retryCount,
          responseStatus: providerRun.responseStatus ?? undefined,
        };
      } else {
        try {
          await this.assertProviderCallEnabled(providerRun?.id ?? null);
          writeSafeTrainingLog(
            this.logger,
            'log',
            'training.provider.request.started',
            {
              correlationId: payload.correlationId,
              jobId: job.id,
              attemptId: payload.attemptId,
              answerId: context.id,
              providerType: 'transcription',
              requestedModel: requestedModelId,
            },
          );
          transcription = await this.transcriptionProvider.transcribe({
            answerId: context.id,
            attemptQuestionId: context.attemptQuestionId,
            review: payload.runType !== TrainingProviderRunType.PRIMARY,
            approvedVocabulary: {
              version: approvedVocabulary.version,
              terms: approvedVocabulary.terms,
            },
            segments: context.voiceSegments.map((segment) => ({
              id: segment.id,
              segmentIndex: segment.segmentIndex,
              fakeTranscript: segment.fileUniqueId,
              ...(segment.originalFile
                ? {
                    fileId: segment.originalFile.id,
                    mimeType: segment.originalFile.mimeType ?? undefined,
                    sizeBytes:
                      segment.originalFile.sizeBytes === null
                        ? undefined
                        : Number(segment.originalFile.sizeBytes),
                    checksum: segment.originalFile.checksum ?? undefined,
                    durationMilliseconds:
                      segment.durationMilliseconds ?? undefined,
                  }
                : {}),
            })),
            ...(context.mergedAudioFile &&
            context.mergedAudioFile.bucket &&
            context.mergedAudioFile.key &&
            context.mergedAudioFile.url === null &&
            context.mergedAudioFile.mimeType &&
            context.mergedAudioFile.sizeBytes !== null &&
            context.mergedAudioFile.checksum &&
            context.mergedAudioDurationMilliseconds !== null
              ? {
                  audio: {
                    fileId: context.mergedAudioFile.id,
                    bucket: context.mergedAudioFile.bucket,
                    key: context.mergedAudioFile.key,
                    mimeType: context.mergedAudioFile.mimeType,
                    sizeBytes: Number(context.mergedAudioFile.sizeBytes),
                    checksum: context.mergedAudioFile.checksum,
                    durationMilliseconds:
                      context.mergedAudioDurationMilliseconds,
                    segmentCount: context.voiceSegments.length,
                  },
                }
              : {}),
          });
          writeSafeTrainingLog(
            this.logger,
            'log',
            'training.provider.request.completed',
            {
              correlationId: payload.correlationId,
              jobId: job.id,
              attemptId: payload.attemptId,
              answerId: context.id,
              providerType: 'transcription',
              actualModel:
                transcription.actualModelId ??
                transcription.requestedModelId,
              providerRequestId: transcription.requestId,
              latencyMs: transcription.latencyMs ?? 0,
              retryCount: transcription.retryCount ?? 0,
              status: 'succeeded',
            },
          );
        } catch (error) {
          if (error instanceof TrainingFeatureDisabledAfterClaimError) {
            throw error;
          }
          if (
            providerRunId &&
            error instanceof TrainingAudioError &&
            error.retryable
          ) {
            await this.releaseProviderRunBeforeHttpRetry(providerRunId);
          } else if (providerRunId) {
            await this.recordProviderRunFailure(providerRunId, error);
          }
          throw error;
        }
      }
    }
    if (!transcription) {
      throw new Error('Transcription result is missing');
    }
    const completedAt = this.clock.now();

    let resultPersisted = false;
    try {
      resultPersisted = await this.runSerializable(async (tx) => {
        await this.acquireAttemptLock(tx, payload.attemptId);
        if (!(await this.refreshOwnedJobWithinTransaction(tx, job.id))) {
          return false;
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
        const currentAttempt = current.attemptQuestion.attempt;
        if (
          payload.runType === TrainingProviderRunType.PRIMARY &&
          this.isTerminalAttemptStatus(currentAttempt.status)
        ) {
          await this.closeAttemptJobsWithinTransaction(
            tx,
            payload.attemptId,
            completedAt,
          );
          return false;
        }
        if (
          payload.runType !== TrainingProviderRunType.PRIMARY &&
          (!this.isTerminalAttemptStatus(currentAttempt.status) ||
            !currentAttempt.isConsumed)
        ) {
          await this.completeJobWithinTransaction(tx, job.id, completedAt);
          return false;
        }

        let activeTranscriptionId = current.activeTranscriptionId;
        if (providerRunId) {
          let persisted =
            await tx.trainingAnswerTranscription.findUnique({
              where: { providerRunId: providerRunId },
              select: { id: true },
            });
          if (!persisted) {
            const aggregate = await tx.trainingAnswerTranscription.aggregate({
              where: { answerId: current.id },
              _max: { transcriptionNumber: true },
            });
            persisted = await tx.trainingAnswerTranscription.create({
              data: {
                answerId: current.id,
                providerRunId,
                transcriptionNumber:
                  (aggregate._max.transcriptionNumber ?? 0) + 1,
                transcript: transcription.transcript,
                language: transcription.language,
                wordCount: transcription.wordCount,
                vocabularyVersion: approvedVocabulary.version,
                vocabularyHash: approvedVocabulary.hash,
              },
              select: { id: true },
            });
            await tx.trainingProviderRun.update({
              where: { id: providerRunId },
              data: {
                status: TrainingProviderRunStatus.SUCCEEDED,
                actualModelId: transcription.actualModelId,
                requestId: transcription.requestId,
                responseStatus: transcription.responseStatus ?? 'completed',
                providerUsageJson: transcription.usage
                  ? (transcription.usage as Prisma.InputJsonObject)
                  : undefined,
                latencyMs: transcription.latencyMs,
                retryCount: transcription.retryCount ?? 0,
                completedAt,
              },
            });
          }
          activeTranscriptionId = persisted.id;
        }

        await tx.trainingAnswer.update({
          where: { id: current.id },
          data: {
            ...(payload.runType === TrainingProviderRunType.PRIMARY
              ? { status: TrainingAnswerStatus.EVALUATING }
              : {}),
            activeTranscriptionId,
            combinedTranscript: transcription.transcript,
            normalizedLanguage: transcription.language,
            transcriptionProvider: transcription.provider,
            transcriptionModel:
              transcription.actualModelId ?? transcription.requestedModelId,
            transcriptionRequestId: transcription.requestId,
            acousticMetricsJson: mergeTranscriptMetrics(
              current.acousticMetricsJson,
              transcription.wordCount,
              current.mergedAudioDurationMilliseconds,
            ),
          },
        });
        await this.enqueueAnswerJobWithinTransaction(
          tx,
          TrainingJobKind.EVALUATE_ANSWER,
          payload.attemptId,
          current.id,
          completedAt,
          payload.runType,
          payload.runNonce,
          payload.correlationId,
        );
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
        return true;
      });
    } catch (error) {
      if (providerRunId) {
        await this.recordProviderPersistenceFailure(providerRunId);
      }
      throw error;
    }
    if (!resultPersisted && providerRunId) {
      await this.recordProviderPersistenceFailure(providerRunId);
    }
  }

  private async processEvaluationJob(job: ClaimedTrainingAttemptJob) {
    const payload = readAttemptJobPayload(job.payloadJson);
    if (!payload.answerId) {
      throw new Error('Evaluation job payload has no answerId');
    }

    const context = await this.loadAnswerProcessingContext(payload.answerId);
    if (
      payload.runType === TrainingProviderRunType.PRIMARY &&
      this.isTerminalAttemptStatus(context.attemptQuestion.attempt.status)
    ) {
      await this.completeTerminalJob(job.id, payload.attemptId);
      return;
    }
    if (
      payload.runType !== TrainingProviderRunType.PRIMARY &&
      (!this.isTerminalAttemptStatus(
        context.attemptQuestion.attempt.status,
      ) ||
        !context.attemptQuestion.attempt.isConsumed)
    ) {
      await this.completeTerminalJob(job.id, payload.attemptId);
      return;
    }
    if (!context.combinedTranscript) {
      throw new Error('Evaluation job has no persisted transcript');
    }

    const existingEvaluation =
      payload.runType === TrainingProviderRunType.PRIMARY
        ? await this.prisma.trainingAnswerEvaluation.findFirst({
            where: {
              answerId: context.id,
              evaluationNumber: 1,
            },
            include: {
              scoreComponents: true,
            },
          })
        : null;
    if (
      payload.runType === TrainingProviderRunType.PRIMARY &&
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
    let providerRunId: string | null = existingEvaluation?.providerRunId ?? null;
    const criteria = await this.prisma.trainingEvaluationCriterion.findMany({
      where: {
        projectVersionId: context.attemptQuestion.attempt.projectVersionId,
        questionType: context.attemptQuestion.question.type,
      },
      orderBy: { sortOrder: 'asc' },
    });
    const factLinks = context.attemptQuestion.question.factLinks.filter(
      (link) => link.fact.isApproved,
    );
    const evaluationInput: TrainingEvaluationInput = {
      answerId: context.id,
      questionId: context.attemptQuestion.question.id,
      review: payload.runType !== TrainingProviderRunType.PRIMARY,
      questionType: context.attemptQuestion.question.type,
      questionText: context.attemptQuestion.question.text,
      questionMaxScore: context.attemptQuestion.question.maxScore,
      transcript: context.combinedTranscript,
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        code: criterion.code,
        title: criterion.title,
        description: criterion.description ?? undefined,
        maxPoints: Number(criterion.maxPoints),
        anchors: parseEvaluationAnchors(
          criterion.anchorsJson,
          Number(criterion.maxPoints),
        ),
      })),
      facts: factLinks.map((link) => ({
        id: link.fact.id,
        code: link.fact.code,
        statement: link.fact.statement,
        acceptedAliases: readStringArray(link.fact.acceptedAliasesJson),
        required: link.isRequired,
      })),
      metrics: buildEvaluationMetrics(
        context.acousticMetricsJson,
        context.mergedAudioDurationMilliseconds,
      ),
    };

    if (!existingEvaluation) {
      const requestedModelId = this.resolveEvaluationModel(payload.runType);
      this.assertRuntimeEnabled();
      const providerRun = await this.prepareProviderRun({
        jobId: job.id,
        answerId: context.id,
        kind: TrainingProviderKind.EVALUATION,
        runType: payload.runType,
        requestedModelId,
        reasoningEffort: this.resolveEvaluationReasoning(payload.runType),
        transcriptHash: createHash('sha256')
          .update(context.combinedTranscript)
          .digest('hex'),
        inputHash: hashProviderInput({
          questionId: evaluationInput.questionId,
          transcript: context.combinedTranscript,
          criteria: evaluationInput.criteria,
          facts: evaluationInput.facts,
          metrics: evaluationInput.metrics,
          runType: payload.runType,
        }),
        inputMetadata: {
          questionId: evaluationInput.questionId,
          criterionIds: evaluationInput.criteria.map(
            (criterion) => criterion.id,
          ),
          factIds: evaluationInput.facts.map((fact) => fact.id),
          metricIds: evaluationInput.metrics.map((metric) => metric.id),
          ...(payload.correlationId
            ? { correlationId: payload.correlationId }
            : {}),
        },
        promptVersion: TRAINING_EVALUATION_PROMPT_VERSION,
        schemaVersion: TRAINING_EVALUATION_SCHEMA_VERSION,
        rubricVersion: `${context.attemptQuestion.attempt.projectVersion.versionNumber}`,
      });
      providerRunId = providerRun?.id ?? null;
      if (providerRunId) {
        evaluationInput.providerRunId = providerRunId;
      }

      if (providerRun?.status === TrainingProviderRunStatus.SUCCEEDED) {
        const recovered =
          await this.prisma.trainingAnswerEvaluation.findUnique({
            where: { providerRunId: providerRun.id },
            include: { scoreComponents: true },
          });
        if (!recovered) {
          throw new Error('Succeeded evaluation provider run has no result');
        }
      } else {
        try {
          await this.assertProviderCallEnabled(providerRun?.id ?? null);
          writeSafeTrainingLog(
            this.logger,
            'log',
            'training.provider.request.started',
            {
              correlationId: payload.correlationId,
              jobId: job.id,
              attemptId: payload.attemptId,
              answerId: context.id,
              providerType: 'evaluation',
              requestedModel: requestedModelId,
            },
          );
          const evaluation =
            await this.evaluationProvider.evaluate(evaluationInput);
          writeSafeTrainingLog(
            this.logger,
            'log',
            'training.provider.request.completed',
            {
              correlationId: payload.correlationId,
              jobId: job.id,
              attemptId: payload.attemptId,
              answerId: context.id,
              providerType: 'evaluation',
              actualModel:
                evaluation.actualModelId ??
                evaluation.requestedModelId,
              providerRequestId: evaluation.requestId,
              latencyMs: evaluation.latencyMs ?? 0,
              retryCount: evaluation.retryCount ?? 0,
              status: 'succeeded',
            },
          );
          evaluationResult = {
            evaluation,
            score: scoreTrainingEvaluation({
              questionMaxScore: evaluationInput.questionMaxScore,
              transcript: evaluationInput.transcript,
              criteria: evaluationInput.criteria,
              facts: evaluationInput.facts,
              evaluation,
            }),
          };
        } catch (error) {
          if (error instanceof TrainingFeatureDisabledAfterClaimError) {
            throw error;
          }
          if (providerRunId) {
            await this.recordProviderRunFailure(providerRunId, error);
          }
          throw error;
        }
      }
    }

    const completedAt = this.clock.now();
    let resultPersisted = false;
    try {
      resultPersisted = await this.runSerializable(async (tx) => {
        await this.acquireAttemptLock(tx, payload.attemptId);
        if (!(await this.refreshOwnedJobWithinTransaction(tx, job.id))) {
          return false;
        }
        const currentAnswer = await tx.trainingAnswer.findUnique({
          where: { id: context.id },
          include: {
            attemptQuestion: {
              include: {
                attempt: true,
              },
            },
          },
        });
        if (!currentAnswer) {
          throw new NotFoundException('Training answer not found');
        }
        const currentAttempt = currentAnswer.attemptQuestion.attempt;
        if (
          payload.runType !== TrainingProviderRunType.PRIMARY &&
          (!this.isTerminalAttemptStatus(currentAttempt.status) ||
            !currentAttempt.isConsumed)
        ) {
          await this.completeJobWithinTransaction(tx, job.id, completedAt);
          return false;
        }

        let persistedEvaluation = providerRunId
          ? await tx.trainingAnswerEvaluation.findUnique({
              where: { providerRunId },
              select: { id: true },
            })
          : payload.runType === TrainingProviderRunType.PRIMARY
            ? await tx.trainingAnswerEvaluation.findFirst({
                where: {
                  answerId: context.id,
                  evaluationNumber: 1,
                },
                select: { id: true },
              })
            : null;

        if (!persistedEvaluation) {
          if (!evaluationResult) {
            throw new Error('Recovered evaluation result is missing');
          }
          const { evaluation, score } = evaluationResult;
          const nextEvaluationNumber =
            providerRunId ||
            payload.runType !== TrainingProviderRunType.PRIMARY
              ? ((await tx.trainingAnswerEvaluation.aggregate({
                  where: { answerId: context.id },
                  _max: { evaluationNumber: true },
                }))._max.evaluationNumber ?? 0) + 1
              : 1;
          persistedEvaluation = await tx.trainingAnswerEvaluation.create({
            data: {
              answerId: context.id,
              providerRunId,
              evaluationNumber: nextEvaluationNumber,
              actualModelId:
                evaluation.actualModelId ?? evaluation.requestedModelId,
              reasoningEffort: evaluation.reasoningEffort,
              promptVersion: TRAINING_EVALUATION_PROMPT_VERSION,
              schemaVersion: TRAINING_EVALUATION_SCHEMA_VERSION,
              rubricVersion: `${context.attemptQuestion.attempt.projectVersion.versionNumber}`,
              structuredResultJson:
                evaluation as unknown as Prisma.InputJsonObject,
              aiSuggestedScore: score.aiSuggestedScore,
              serverScore: score.serverScore,
              summary: evaluation.summary.slice(0, 2_000),
              requiresReview: score.requiresReview,
              reviewReasonsJson: score.reviewReasons,
              providerUsageJson: evaluation.usage
                ? (evaluation.usage as Prisma.InputJsonObject)
                : undefined,
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
          if (providerRunId) {
            await tx.trainingProviderRun.update({
              where: { id: providerRunId },
              data: {
                status: TrainingProviderRunStatus.SUCCEEDED,
                actualModelId: evaluation.actualModelId,
                requestId: evaluation.requestId,
                responseStatus: evaluation.responseStatus ?? 'completed',
                providerUsageJson: evaluation.usage
                  ? (evaluation.usage as Prisma.InputJsonObject)
                  : undefined,
                latencyMs: evaluation.latencyMs,
                retryCount: evaluation.retryCount ?? 0,
                completedAt,
              },
            });
          }
        }

        await tx.trainingAnswer.update({
          where: { id: context.id },
          data: {
            status: TrainingAnswerStatus.SCORED,
            activeEvaluationId: persistedEvaluation.id,
            processingFinishedAt: completedAt,
            errorCode: null,
            errorMessage: null,
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
        if (payload.runType === TrainingProviderRunType.PRIMARY) {
          await this.advanceOrFinalize(
            tx,
            payload.attemptId,
            context.attemptQuestion.sequence,
            completedAt,
            payload.correlationId,
          );
        } else {
          const originalCompletedAt =
            currentAttempt.completedAt ?? completedAt;
          await tx.trainingAttempt.update({
            where: { id: currentAttempt.id },
            data: {
              status: TrainingAttemptStatus.FINALIZING,
              adminScore: null,
            },
          });
          await this.finalizeWithinTransaction(
            tx,
            currentAttempt.id,
            originalCompletedAt,
            payload.correlationId,
          );
        }
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
        return true;
      });
    } catch (error) {
      if (providerRunId) {
        await this.recordProviderPersistenceFailure(providerRunId);
      }
      throw error;
    }
    if (!resultPersisted && providerRunId) {
      await this.recordProviderPersistenceFailure(providerRunId);
    }
  }

  private async processFinalizationJob(job: ClaimedTrainingAttemptJob) {
    const payload = readAttemptJobPayload(job.payloadJson);
    const completedAt = this.clock.now();
    writeSafeTrainingLog(
      this.logger,
      'log',
      'training.attempt.finalization.started',
      {
        correlationId: payload.correlationId,
        jobId: job.id,
        attemptId: payload.attemptId,
        workerKind: 'attempt',
      },
    );

    await this.runSerializable(async (tx) => {
      await this.acquireAttemptLock(tx, payload.attemptId);
      this.assertRuntimeEnabled();
      const finalized = await this.finalizeWithinTransaction(
        tx,
        payload.attemptId,
        completedAt,
        payload.correlationId,
      );
      if (finalized) {
        await this.completeJobWithinTransaction(tx, job.id, completedAt);
        return;
      }

      await this.releaseJobWithinTransaction(
        tx,
        job,
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
        mergedAudioFile: true,
        voiceSegments: {
          orderBy: { segmentIndex: 'asc' },
          include: {
            originalFile: true,
          },
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
                projectVersion: {
                  include: {
                    project: {
                      include: {
                        realEstateObject: {
                          include: {
                            developer: true,
                            primaryLocation: true,
                            locations: {
                              include: {
                                location: true,
                              },
                            },
                            metroStations: {
                              include: {
                                metroStation: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
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

  private async prepareProviderRun(input: {
    jobId: string;
    answerId: string;
    kind: TrainingProviderKind;
    runType: TrainingProviderRunType;
    requestedModelId: string;
    reasoningEffort?: string | null;
    sourceFileId?: string | null;
    sourceChecksum?: string | null;
    transcriptHash?: string | null;
    inputHash: string;
    inputMetadata: Prisma.InputJsonObject;
    promptVersion?: string | null;
    schemaVersion?: string | null;
    rubricVersion?: string | null;
  }) {
    if (!this.prisma.trainingProviderRun) {
      return null;
    }
    const idempotencyKey = `training-provider:${input.kind}:${input.jobId}`;
    let run = await this.prisma.trainingProviderRun.findUnique({
      where: { idempotencyKey },
    });
    if (!run) {
      try {
        run = await this.prisma.trainingProviderRun.create({
          data: {
            answerId: input.answerId,
            kind: input.kind,
            runType: input.runType,
            status: TrainingProviderRunStatus.PENDING,
            idempotencyKey,
            requestedModelId: input.requestedModelId,
            reasoningEffort: input.reasoningEffort,
            sourceFileId: input.sourceFileId,
            sourceChecksum: input.sourceChecksum,
            transcriptHash: input.transcriptHash,
            inputHash: input.inputHash,
            inputMetadataJson: input.inputMetadata,
            promptVersion: input.promptVersion,
            schemaVersion: input.schemaVersion,
            rubricVersion: input.rubricVersion,
          },
        });
      } catch (error) {
        if (!this.isPrismaConcurrencyError(error)) throw error;
        run = await this.prisma.trainingProviderRun.findUnique({
          where: { idempotencyKey },
        });
        if (!run) throw error;
      }
    }
    if (!run) {
      throw new ConflictException('OpenAI provider run could not be loaded');
    }

    if (
      run.answerId !== input.answerId ||
      run.kind !== input.kind ||
      run.runType !== input.runType
    ) {
      throw new ConflictException(
        'OpenAI provider run does not match the requested training operation',
      );
    }
    if (run.status === TrainingProviderRunStatus.PENDING) {
      await this.prisma.trainingProviderRun.updateMany({
        where: {
          id: run.id,
          status: TrainingProviderRunStatus.PENDING,
        },
        data: {
          requestedModelId: input.requestedModelId,
          reasoningEffort: input.reasoningEffort,
          sourceFileId: input.sourceFileId,
          sourceChecksum: input.sourceChecksum,
          transcriptHash: input.transcriptHash,
          inputHash: input.inputHash,
          inputMetadataJson: input.inputMetadata,
          promptVersion: input.promptVersion,
          schemaVersion: input.schemaVersion,
          rubricVersion: input.rubricVersion,
        },
      });
      run = await this.prisma.trainingProviderRun.findUnique({
        where: { idempotencyKey },
      });
      if (!run) {
        throw new ConflictException(
          'OpenAI provider run disappeared during metadata refresh',
        );
      }
    }

    if (run.status === TrainingProviderRunStatus.SUCCEEDED) return run;
    if (run.status === TrainingProviderRunStatus.REQUESTING) {
      await this.prisma.trainingProviderRun.update({
        where: { id: run.id },
        data: {
          status: TrainingProviderRunStatus.AMBIGUOUS,
          ambiguousOutcome: true,
          errorCode: 'OPENAI_RECOVERED_REQUEST_AMBIGUOUS',
          errorClass: 'recovery',
          completedAt: this.clock.now(),
        },
      });
      throw new TrainingOpenAiRequestError(
        'OPENAI_RECOVERED_REQUEST_AMBIGUOUS',
        false,
        true,
        null,
        run.requestId,
        run.retryCount,
        'A persisted OpenAI request was interrupted with an ambiguous outcome',
      );
    }
    if (
      run.status === TrainingProviderRunStatus.AMBIGUOUS ||
      run.status === TrainingProviderRunStatus.FAILED
    ) {
      throw new TrainingOpenAiRequestError(
        run.errorCode ?? 'OPENAI_PROVIDER_RUN_NOT_RETRYABLE',
        false,
        run.ambiguousOutcome,
        null,
        run.requestId,
        run.retryCount,
        'OpenAI provider run is terminal and requires explicit reprocessing',
      );
    }

    const startedAt = this.clock.now();
    const claimed = await this.prisma.trainingProviderRun.updateMany({
      where: {
        id: run.id,
        status: TrainingProviderRunStatus.PENDING,
      },
      data: {
        status: TrainingProviderRunStatus.REQUESTING,
        startedAt,
        errorCode: null,
        errorClass: null,
        ambiguousOutcome: false,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('OpenAI provider run could not be claimed');
    }
    return {
      ...run,
      status: TrainingProviderRunStatus.REQUESTING,
      startedAt,
    };
  }

  private async recordProviderRunFailure(runId: string, error: unknown) {
    const openAiError =
      error instanceof TrainingOpenAiRequestError ? error : null;
    const ambiguous = openAiError?.ambiguous ?? false;
    await this.prisma.trainingProviderRun.updateMany({
      where: {
        id: runId,
        status: TrainingProviderRunStatus.REQUESTING,
      },
      data: {
        status: ambiguous
          ? TrainingProviderRunStatus.AMBIGUOUS
          : TrainingProviderRunStatus.FAILED,
        requestId: openAiError?.requestId,
        responseStatus:
          openAiError?.status === null || openAiError?.status === undefined
            ? ambiguous
              ? 'ambiguous'
              : 'failed'
            : `http_${openAiError.status}`,
        retryCount: openAiError?.retryCount ?? 0,
        errorCode: openAiError?.code ?? 'OPENAI_PROVIDER_FAILED',
        errorClass: error instanceof Error ? error.name.slice(0, 120) : 'Error',
        ambiguousOutcome: ambiguous,
        completedAt: this.clock.now(),
      },
    });
  }

  private async releaseProviderRunBeforeHttpRetry(runId: string) {
    await this.prisma.trainingProviderRun.updateMany({
      where: {
        id: runId,
        status: TrainingProviderRunStatus.REQUESTING,
      },
      data: {
        status: TrainingProviderRunStatus.PENDING,
        startedAt: null,
        requestId: null,
        responseStatus: null,
        errorCode: null,
        errorClass: null,
        ambiguousOutcome: false,
        completedAt: null,
      },
    });
  }

  private async recordProviderPersistenceFailure(runId: string) {
    await this.prisma.trainingProviderRun.updateMany({
      where: {
        id: runId,
        status: TrainingProviderRunStatus.REQUESTING,
      },
      data: {
        status: TrainingProviderRunStatus.FAILED,
        responseStatus: 'persistence_failed',
        errorCode: 'OPENAI_RESULT_PERSISTENCE_FAILED',
        errorClass: 'persistence',
        ambiguousOutcome: false,
        completedAt: this.clock.now(),
      },
    });
  }

  private resolveTranscriptionModel(runType: TrainingProviderRunType) {
    if (this.openAiConfig?.providerMode === 'real') {
      return runType === TrainingProviderRunType.PRIMARY
        ? this.openAiConfig.transcriptionModel
        : this.openAiConfig.transcriptionReviewModel;
    }
    return 'fake-transcription-v1';
  }

  private resolveEvaluationModel(runType: TrainingProviderRunType) {
    if (this.openAiConfig?.providerMode === 'real') {
      return runType === TrainingProviderRunType.PRIMARY
        ? this.openAiConfig.evaluationModel
        : this.openAiConfig.reviewModel;
    }
    return 'fake-evaluation-v1';
  }

  private resolveEvaluationReasoning(runType: TrainingProviderRunType) {
    if (this.openAiConfig?.providerMode !== 'real') return null;
    return runType === TrainingProviderRunType.PRIMARY
      ? this.openAiConfig.evaluationReasoning
      : this.openAiConfig.reviewReasoning;
  }

  private async advanceOrFinalize(
    tx: Prisma.TransactionClient,
    attemptId: string,
    completedSequence: number,
    now: Date,
    correlationId: string | null = null,
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
      await this.enqueueFinalizeJobWithinTransaction(
        tx,
        attempt.id,
        now,
        correlationId,
      );
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
    await enqueueAttemptTelegramOutboxEvent(tx, {
      eventType: 'ATTEMPT_QUESTION',
      attemptId: attempt.id,
      attemptQuestionId: nextQuestion.id,
      idempotencyKey: `telegram:attempt:${attempt.id}:question:${nextQuestion.id}`,
      runAt: now,
      correlationId,
    });
  }

  private async finalizeWithinTransaction(
    tx: Prisma.TransactionClient,
    attemptId: string,
    completedAt: Date,
    correlationId: string | null = null,
  ) {
    const attempt = await tx.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          include: {
            answer: {
              include: {
                activeEvaluation: true,
                evaluations: {
                  orderBy: { evaluationNumber: 'desc' },
                  take: 1,
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
      (question) => {
        const evaluation =
          question.answer?.activeEvaluation ??
          question.answer?.evaluations[0] ??
          null;
        return evaluation ? [evaluation] : [];
      },
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
    await enqueueAttemptTelegramOutboxEvent(tx, {
      eventType: 'ATTEMPT_RESULT',
      attemptId: attempt.id,
      idempotencyKey: `telegram:attempt-result:${attempt.id}`,
      runAt: new Date(completedAt.getTime() + 100),
      correlationId,
    });
    await this.closeAttemptJobsWithinTransaction(tx, attempt.id, completedAt);
    return true;
  }

  private getAnswerProcessingJobKind(answer: {
    status: TrainingAnswerStatus;
    mergedAudioFileId?: string | null;
  }) {
    if (answer.status === TrainingAnswerStatus.EVALUATING) {
      return TrainingJobKind.EVALUATE_ANSWER;
    }
    if (
      this.audioConfig &&
      !answer.mergedAudioFileId &&
      (answer.status === TrainingAnswerStatus.READY ||
        answer.status === TrainingAnswerStatus.DOWNLOADING)
    ) {
      return TrainingJobKind.ASSEMBLE_ANSWER_AUDIO;
    }
    return TrainingJobKind.TRANSCRIBE_ANSWER;
  }

  private async enqueueAnswerJobWithinTransaction(
    tx: Prisma.TransactionClient,
    kind:
      | typeof TrainingJobKind.ASSEMBLE_ANSWER_AUDIO
      | typeof TrainingJobKind.TRANSCRIBE_ANSWER
      | typeof TrainingJobKind.EVALUATE_ANSWER,
    attemptId: string,
    answerId: string,
    runAt: Date,
    runType: TrainingProviderRunType = TrainingProviderRunType.PRIMARY,
    runNonce?: string | null,
    correlationId?: string | null,
  ) {
    if (runType !== TrainingProviderRunType.PRIMARY && !runNonce) {
      throw new Error('Reprocessing job requires a stable run nonce');
    }
    const action =
      kind === TrainingJobKind.ASSEMBLE_ANSWER_AUDIO
        ? 'assemble'
        : kind === TrainingJobKind.TRANSCRIBE_ANSWER
          ? 'transcribe'
          : 'evaluate';
    await tx.trainingJob.createMany({
      data: [
        {
          kind,
          status: TrainingJobStatus.PENDING,
          payloadJson: {
            attemptId,
            answerId,
            runType,
            ...(runNonce ? { runNonce } : {}),
            ...(readTrainingCorrelationId(correlationId)
              ? { correlationId }
              : {}),
          },
          idempotencyKey:
            runType === TrainingProviderRunType.PRIMARY
              ? `attempt:${attemptId}:answer:${answerId}:${action}`
              : `attempt:${attemptId}:answer:${answerId}:${action}:${runNonce}`,
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
    correlationId?: string | null,
  ) {
    await tx.trainingJob.createMany({
      data: [
        {
          kind: TrainingJobKind.FINALIZE_ATTEMPT,
          status: TrainingJobStatus.PENDING,
          payloadJson: {
            attemptId,
            ...(readTrainingCorrelationId(correlationId)
              ? { correlationId }
              : {}),
          },
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
    job: ClaimedTrainingAttemptJob,
    runAt: Date,
    errorCode: string,
    errorMessage: string,
  ) {
    await tx.trainingJob.updateMany({
      where: {
        id: job.id,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts: job.attempts,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        attempts: Math.max(0, job.attempts - 1),
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

  private assertRuntimeEnabled() {
    if (this.trainingConfig?.isEnabled() === false) {
      throw new TrainingFeatureDisabledAfterClaimError();
    }
  }

  private async assertProviderCallEnabled(providerRunId: string | null) {
    const runtimeDisabled = this.trainingConfig?.isEnabled() === false;
    if (!runtimeDisabled && !this.destroyed) return;
    if (providerRunId) {
      await this.releaseProviderRunBeforeHttpRetry(providerRunId);
    }
    if (this.destroyed) {
      throw new TrainingAttemptWorkerShutdownError();
    }
    throw new TrainingFeatureDisabledAfterClaimError();
  }

  private async releaseJobAfterFeatureDisable(
    job: ClaimedTrainingAttemptJob,
  ) {
    await this.prisma.trainingJob.updateMany({
      where: {
        id: job.id,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts: job.attempts,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        attempts: { decrement: 1 },
        runAt: this.clock.now(),
        finishedAt: null,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: 'TRAINING_DISABLED_AFTER_CLAIM',
        lastErrorMessage: 'Training job released after runtime disable',
        errorDetailsJson: { retryable: true },
      },
    });
  }

  private async releaseJobAfterShutdown(job: ClaimedTrainingAttemptJob) {
    await this.prisma.trainingJob.updateMany({
      where: {
        id: job.id,
        status: TrainingJobStatus.RUNNING,
        lockOwner: this.workerId,
        attempts: job.attempts,
      },
      data: {
        status: TrainingJobStatus.PENDING,
        attempts: Math.max(0, job.attempts - 1),
        runAt: this.clock.now(),
        finishedAt: null,
        lockOwner: null,
        lockedAt: null,
        heartbeatAt: null,
        lastErrorCode: 'ATTEMPT_SHUTDOWN_RELEASE',
        lastErrorMessage: 'Training attempt job released during shutdown',
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
    const payload = tryReadAttemptJobPayload(job.payloadJson);
    const failedAt = this.clock.now();
    const message = toSafeErrorMessage(error);
    const audioError = error instanceof TrainingAudioError ? error : null;
    const openAiError =
      error instanceof TrainingOpenAiRequestError ? error : null;
    const retryable = audioError?.retryable ?? false;
    const shouldRetry =
      requireOwnership && retryable && job.attempts < job.maxAttempts;
    const errorCode =
      payload === null
        ? 'ATTEMPT_JOB_PAYLOAD_INVALID'
        : audioError?.code ?? openAiError?.code ?? 'ATTEMPT_JOB_FAILED';
    const reprocessing =
      payload !== null &&
      payload.runType !== TrainingProviderRunType.PRIMARY;
    const retryDelayMs = Math.max(
      Math.min(30_000, 250 * 2 ** Math.max(0, job.attempts - 1)),
      audioError?.retryAfterMs ?? 0,
    );

    await this.runSerializable(async (tx) => {
      if (payload) {
        await this.acquireAttemptLock(tx, payload.attemptId);
      }
      const failedJob = await tx.trainingJob.updateMany({
        where: {
          id: job.id,
          ...(requireOwnership
            ? {
                status: TrainingJobStatus.RUNNING,
                lockOwner: this.workerId,
                attempts: job.attempts,
              }
            : {
                status: job.status,
                attempts: job.attempts,
                lockOwner: job.lockOwner,
                lockedAt: job.lockedAt,
                heartbeatAt: job.heartbeatAt,
              }),
        },
        data: {
          status: shouldRetry
            ? TrainingJobStatus.PENDING
            : TrainingJobStatus.DEAD,
          runAt: shouldRetry
            ? new Date(failedAt.getTime() + retryDelayMs)
            : failedAt,
          finishedAt: shouldRetry ? null : failedAt,
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: errorCode,
          lastErrorMessage: message,
          errorDetailsJson: {
            retryable,
            retryAfterMs: audioError?.retryAfterMs ?? null,
            ambiguousOutcome: openAiError?.ambiguous ?? false,
            providerRequestId: openAiError?.requestId ?? null,
          },
        },
      });
      if (failedJob.count === 0) {
        return;
      }
      if (shouldRetry) {
        return;
      }
      if (payload?.answerId && !reprocessing) {
        await tx.trainingAnswer.updateMany({
          where: { id: payload.answerId },
          data: {
            status: TrainingAnswerStatus.FAILED,
            processingFinishedAt: failedAt,
            errorCode,
            errorMessage: message,
          },
        });
      }
      if (payload && !reprocessing) {
        const transitioned = await tx.trainingAttempt.updateMany({
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
        if (transitioned.count === 1) {
          await enqueueAttemptTelegramOutboxEvent(tx, {
            eventType: 'TECHNICAL_FAILURE',
            attemptId: payload.attemptId,
            idempotencyKey: `telegram:attempt-technical-failure:${payload.attemptId}`,
            runAt: failedAt,
          });
        }
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
    await acquireTrainingProjectAudienceLock(tx, projectId);
    await acquireTrainingUserProjectLock(tx, userId, projectId);
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

  const answerId =
    typeof value.answerId === 'string' ? value.answerId : null;
  return {
    attemptId: value.attemptId,
    answerId,
    runType:
      value.runType === TrainingProviderRunType.REPROCESS ||
      value.runType === TrainingProviderRunType.REVIEW
        ? value.runType
        : TrainingProviderRunType.PRIMARY,
    runNonce: typeof value.runNonce === 'string' ? value.runNonce : null,
    correlationId: resolveTrainingCorrelationId(
      value.correlationId,
      answerId
        ? `training-answer:${answerId}`
        : `training-attempt:${value.attemptId}`,
    ),
  };
}

function tryReadAttemptJobPayload(value: Prisma.JsonValue) {
  try {
    return readAttemptJobPayload(value);
  } catch {
    return null;
  }
}

function readTelegramAttemptDeliveryPayload(value: Prisma.JsonValue) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.operation !== 'DOMAIN_EVENT' ||
    typeof value.eventType !== 'string' ||
    typeof value.attemptId !== 'string'
  ) {
    return null;
  }
  if (value.eventType === 'TECHNICAL_FAILURE') {
    return {
      eventType: value.eventType,
      attemptId: value.attemptId,
      attemptQuestionId: null,
    } as const;
  }
  if (
    value.eventType === 'ATTEMPT_QUESTION' &&
    typeof value.attemptQuestionId === 'string'
  ) {
    return {
      eventType: value.eventType,
      attemptId: value.attemptId,
      attemptQuestionId: value.attemptQuestionId,
    } as const;
  }
  return null;
}

function toSafeErrorMessage(error: unknown) {
  return safeTrainingFailureMessage(error, 'Training attempt job failed');
}

function mergeTranscriptMetrics(
  current: Prisma.JsonValue,
  wordCount: number,
  durationMilliseconds: number | null,
): Prisma.InputJsonObject {
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Prisma.JsonObject)
      : {};
  const durationMinutes =
    durationMilliseconds && durationMilliseconds > 0
      ? durationMilliseconds / 60_000
      : 0;
  return {
    ...base,
    transcript: {
      wordCount,
      wordsPerMinute:
        durationMinutes > 0
          ? Math.round((wordCount / durationMinutes) * 1_000) / 1_000
          : null,
    },
  };
}

function countTranscriptWords(value: string) {
  return value.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function buildApprovedVocabulary(context: {
  attemptQuestion: {
    attempt: {
      projectVersion: {
        versionNumber: number;
        project?: {
          title: string;
          realEstateObject: {
            title: string;
            mapName: string | null;
            krtName: string | null;
            developer: { name: string } | null;
            primaryLocation: { name: string } | null;
            locations: Array<{ location: { name: string } }>;
            metroStations: Array<{
              metroStation: {
                name: string;
                lineName: string | null;
              };
            }>;
          } | null;
        };
      };
    };
    question: {
      factLinks: Array<{
        fact: {
          statement: string;
          acceptedAliasesJson: Prisma.JsonValue;
          isApproved: boolean;
        };
      }>;
    };
  };
}) {
  const projectVersion =
    context.attemptQuestion.attempt.projectVersion;
  const project = projectVersion.project;
  const object = project?.realEstateObject;
  return buildSafeTrainingVocabulary({
    projectVersionNumber: projectVersion.versionNumber,
    projectTitle: project?.title ?? '',
    object: object
      ? {
          title: object.title,
          mapName: object.mapName,
          krtName: object.krtName,
          developerName: object.developer?.name,
          primaryLocationName: object.primaryLocation?.name,
          locationNames: object.locations.map(
            (link) => link.location.name,
          ),
          metroStations: object.metroStations.map((link) => ({
            name: link.metroStation.name,
            lineName: link.metroStation.lineName,
          })),
        }
      : null,
    approvedFacts: context.attemptQuestion.question.factLinks
      .filter((link) => link.fact.isApproved)
      .map((link) => ({
        statement: link.fact.statement,
        acceptedAliases: readStringArray(
          link.fact.acceptedAliasesJson,
        ),
      })),
  });
}

function parseEvaluationAnchors(
  value: Prisma.JsonValue,
  maxPoints: number,
) {
  if (!Array.isArray(value)) return [];
  const anchors: Array<{
    id: string;
    points: number;
    description: string;
  }> = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isJsonRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const points = typeof item.points === 'number' ? item.points : Number.NaN;
    const description =
      typeof item.description === 'string' ? item.description.trim() : '';
    if (
      !id ||
      id.length > 120 ||
      ids.has(id) ||
      !description ||
      description.length > 2_000 ||
      !Number.isFinite(points) ||
      points < 0 ||
      points > maxPoints
    ) {
      continue;
    }
    ids.add(id);
    anchors.push({ id, points, description });
  }
  return anchors;
}

function buildEvaluationMetrics(
  value: Prisma.JsonValue,
  durationMilliseconds: number | null,
) {
  const metrics: Array<{ id: string; value: number; unit: string }> = [];
  if (durationMilliseconds !== null && durationMilliseconds >= 0) {
    metrics.push({
      id: 'audio_duration_milliseconds',
      value: durationMilliseconds,
      unit: 'milliseconds',
    });
  }
  if (isJsonRecord(value) && isJsonRecord(value.transcript)) {
    const wordCount = value.transcript.wordCount;
    const wordsPerMinute = value.transcript.wordsPerMinute;
    if (typeof wordCount === 'number' && Number.isFinite(wordCount)) {
      metrics.push({ id: 'transcript_word_count', value: wordCount, unit: 'words' });
    }
    if (
      typeof wordsPerMinute === 'number' &&
      Number.isFinite(wordsPerMinute)
    ) {
      metrics.push({
        id: 'speech_words_per_minute',
        value: wordsPerMinute,
        unit: 'words_per_minute',
      });
    }
  }
  return metrics;
}

function readStringArray(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hashProviderInput(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isJsonRecord(
  value: Prisma.JsonValue | undefined,
): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: Prisma.JsonValue | null) {
  return isJsonRecord(value ?? undefined)
    ? (value as Record<string, unknown>)
    : undefined;
}

type UnsupportedClaimDecision = {
  componentKey: string;
  decision: 'ACCEPTED' | 'INCORRECT';
};

function parseUnsupportedClaimDecisionPayload(
  value: unknown,
): UnsupportedClaimDecision[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException(
      'Unsupported claim decisions must be an array',
    );
  }
  const seen = new Set<string>();
  const decisions = value.map((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'componentKey,decision' ||
      typeof item.componentKey !== 'string' ||
      (item.decision !== 'ACCEPTED' && item.decision !== 'INCORRECT')
    ) {
      throw new BadRequestException(
        'Unsupported claim decision is invalid',
      );
    }
    if (seen.has(item.componentKey)) {
      throw new BadRequestException(
        'Unsupported claim decision references a duplicate component',
      );
    }
    seen.add(item.componentKey);
    return {
      componentKey: item.componentKey,
      decision: item.decision,
    };
  });
  return decisions;
}

function parseUnsupportedClaimDecisions(
  decisions: UnsupportedClaimDecision[],
  expectedComponentKeys: string[],
) {
  const expected = new Set(expectedComponentKeys);
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (
      !expected.has(decision.componentKey) ||
      seen.has(decision.componentKey)
    ) {
      throw new BadRequestException(
        'Unsupported claim decision references an unknown or duplicate component',
      );
    }
    seen.add(decision.componentKey);
  }
  if (seen.size !== expected.size) {
    throw new BadRequestException(
      'Every unsupported claim requires a reviewer decision',
    );
  }
  return decisions;
}

export const TRAINING_ATTEMPT_SCORE_MAXIMUM = TRAINING_TOTAL_MAX_SCORE;

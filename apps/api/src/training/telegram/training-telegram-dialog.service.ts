import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingPassStatus,
  TrainingPolicyAcceptanceSource,
  TrainingProjectStatus,
  TrainingReviewStatus,
  TrainingVersionStatus,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TrainingAttemptEngineService } from '../training-attempt-engine.service';
import { TRAINING_ACTIVE_ATTEMPT_STATUSES } from '../training.domain';
import { TrainingPolicyService } from '../training-policy.service';
import { trainingProjectAudienceWhere } from '../training-project-access';
import { CURRENT_TRAINING_POLICY } from '../training-policy.seed';
import {
  encodeFinishCallback,
  encodePolicyAcceptStartCallback,
  encodeProjectCallback,
  encodeStartCallback,
  parseTrainingTelegramCallback,
} from './training-telegram.callback';
import { TrainingTelegramConfig } from './training-telegram.config';
import {
  TrainingTelegramLinkService,
  type TrainingTelegramIdentity,
} from './training-telegram-link.service';
import type { TrainingTelegramOutboxEvent } from './training-telegram-outbox';
import type {
  SanitizedTelegramCallbackUpdate,
  SanitizedTelegramMessageUpdate,
  SanitizedTelegramUpdate,
} from './training-telegram.update';
import type {
  TelegramInlineKeyboard,
} from './training-telegram.transport';

export type DeliveryPlan =
  | {
      operation: 'SEND_MESSAGE';
      chatId: string;
      text: string;
      replyMarkup?: TelegramInlineKeyboard;
      activeAttemptId?: string;
    }
  | {
      operation: 'ANSWER_CALLBACK';
      callbackQueryId: string;
      text?: string;
    };

const TERMINAL_RESULT_STATUSES = [
  TrainingAttemptStatus.COMPLETED,
  TrainingAttemptStatus.REQUIRES_REVIEW,
] as const;

@Injectable()
export class TrainingTelegramDialogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TrainingTelegramConfig,
    private readonly links: TrainingTelegramLinkService,
    private readonly attempts: TrainingAttemptEngineService,
    @Optional()
    private readonly policy?: TrainingPolicyService,
  ) {}

  async listEmployeeProjects(userId: string) {
    const projects = await this.listOpenProjects(userId);
    const items = await Promise.all(
      projects.map(async (project) => {
        const attemptsUsed = await this.prisma.trainingAttempt.count({
          where: {
            userId,
            projectId: project.id,
            isConsumed: true,
          },
        });
        const best = await this.attempts.getBestReviewedScore(userId, project.id);
        return {
          id: project.id,
          slug: project.slug,
          title: project.title,
          description: project.description,
          sortOrder: project.sortOrder,
          deadlineAt: project.deadlineAt?.toISOString() ?? null,
          passScore: project.activeVersion!.passScore,
          attemptLimit: project.activeVersion!.attemptLimit,
          attemptsUsed,
          attemptsLeft: Math.max(
            0,
            project.activeVersion!.attemptLimit - attemptsUsed,
          ),
          cooldownMinutes: project.activeVersion!.cooldownMinutes,
          totalTimeLimitSeconds:
            project.activeVersion!.totalTimeLimitSeconds,
          bestScore: best.bestReviewedScore?.toString() ?? null,
        };
      }),
    );
    return { items };
  }

  async getEmployeeProject(userId: string, projectId: string) {
    const response = await this.listEmployeeProjects(userId);
    const project = response.items.find((item) => item.id === projectId);
    if (!project) throw new NotFoundException('Open training project not found');
    return { project };
  }

  async listEmployeeAttempts(userId: string) {
    const attempts = await this.prisma.trainingAttempt.findMany({
      where: { userId },
      include: {
        project: { select: { id: true, title: true, slug: true } },
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    });
    return {
      items: attempts.map(serializeEmployeeAttempt),
    };
  }

  async getEmployeeAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.trainingAttempt.findFirst({
      where: { id: attemptId, userId },
      include: {
        project: { select: { id: true, title: true, slug: true } },
      },
    });
    if (!attempt) {
      throw new NotFoundException('Training attempt not found');
    }
    return { attempt: serializeEmployeeAttempt(attempt) };
  }

  async processUpdate(
    update: SanitizedTelegramUpdate,
    originKey: string,
  ) {
    const plans =
      update.type === 'CALLBACK'
        ? await this.processCallback(update)
        : await this.processMessage(update);
    await this.enqueueDeliveryPlans(
      originKey,
      update.correlationId ?? `telegram-job:${originKey}`,
      plans,
    );
  }

  async deliverAttemptResult(
    attemptId: string,
  ): Promise<DeliveryPlan | null> {
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        project: { select: { title: true } },
        projectVersion: { select: { attemptLimit: true } },
        user: {
          include: {
            trainingTelegramAccount: true,
          },
        },
      },
    });
    if (
      !attempt ||
      !TERMINAL_RESULT_STATUSES.includes(
        attempt.status as (typeof TERMINAL_RESULT_STATUSES)[number],
      ) ||
      attempt.user.status !== UserStatus.ACTIVE ||
      attempt.user.deletedAt ||
      !attempt.user.trainingTelegramAccount ||
      attempt.user.trainingTelegramAccount.revokedAt
    ) {
      return null;
    }
    const attemptsUsed = await this.prisma.trainingAttempt.count({
      where: {
        userId: attempt.userId,
        projectId: attempt.projectId,
        isConsumed: true,
      },
    });
    const attemptsLeft = Math.max(
      0,
      attempt.projectVersion.attemptLimit - attemptsUsed,
    );
    const text =
      attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW ||
      attempt.reviewStatus === TrainingReviewStatus.PENDING
        ? `Результат отправлен на проверку.\nОсталось попыток: ${attemptsLeft}.`
        : `Результат: ${formatScore(attempt.finalScore)}/100.\n${
            attempt.passStatus === TrainingPassStatus.PASSED
              ? 'Аттестация пройдена.'
              : 'Аттестация не пройдена.'
          }\nОсталось попыток: ${attemptsLeft}.`;
    return {
      operation: 'SEND_MESSAGE',
      chatId: attempt.user.trainingTelegramAccount.chatId.toString(),
      text,
      replyMarkup: this.platformKeyboard(),
    };
  }

  async buildTimerWarning(
    attemptId: string,
    warningSeconds: number,
  ): Promise<DeliveryPlan | null> {
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        user: { include: { trainingTelegramAccount: true } },
      },
    });
    if (
      !attempt ||
      !TRAINING_ACTIVE_ATTEMPT_STATUSES.includes(
        attempt.status as (typeof TRAINING_ACTIVE_ATTEMPT_STATUSES)[number],
      ) ||
      attempt.user.status !== UserStatus.ACTIVE ||
      attempt.user.deletedAt ||
      !attempt.user.trainingTelegramAccount ||
      attempt.user.trainingTelegramAccount.revokedAt
    ) {
      return null;
    }
    return {
      operation: 'SEND_MESSAGE',
      chatId: attempt.user.trainingTelegramAccount.chatId.toString(),
      text: `До завершения аттестации осталось ${formatSeconds(warningSeconds)}.`,
      activeAttemptId: attempt.id,
    };
  }

  async buildOutboxEvent(
    event: TrainingTelegramOutboxEvent,
  ): Promise<DeliveryPlan | null> {
    const account = await this.prisma.trainingTelegramAccount.findFirst({
      where: {
        id: event.accountId,
        userId: event.userId,
        chatId: BigInt(event.chatId),
        revokedAt: null,
        user: {
          status: UserStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!account) return null;

    if (event.eventType === 'ACCOUNT_LINKED') {
      return this.message(
        event.chatId,
        'Аккаунт Platforma подключён к Telegram.',
        this.mainMenuKeyboard(),
      );
    }
    if (event.eventType === 'PROJECT_CONFIRMATION') {
      try {
        return await this.projectConfirmation(
          event.userId,
          event.projectId,
          event.chatId,
        );
      } catch {
        return this.message(
          event.chatId,
          'Аккаунт подключён, но выбранный проект сейчас недоступен.',
          this.projectsKeyboard(),
        );
      }
    }
    if (event.eventType === 'ATTEMPT_QUESTION') {
      const question = await this.prisma.trainingAttemptQuestion.findFirst({
        where: {
          id: event.attemptQuestionId,
          attemptId: event.attemptId,
          attempt: { userId: event.userId },
          status: {
            in: [
              TrainingAttemptQuestionStatus.PRESENTED,
              TrainingAttemptQuestionStatus.COLLECTING,
            ],
          },
        },
        include: { question: true },
      });
      return question ? this.questionMessage(event.chatId, question) : null;
    }
    if (event.eventType === 'ANSWER_ACCEPTED') {
      const question = await this.prisma.trainingAttemptQuestion.findFirst({
        where: {
          id: event.attemptQuestionId,
          attemptId: event.attemptId,
          attempt: { userId: event.userId },
          status: {
            in: [
              TrainingAttemptQuestionStatus.LOCKED,
              TrainingAttemptQuestionStatus.PROCESSING,
              TrainingAttemptQuestionStatus.SCORED,
              TrainingAttemptQuestionStatus.SKIPPED_TIMEOUT,
            ],
          },
        },
        select: { id: true },
      });
      return question
        ? this.message(event.chatId, 'Ответ принят')
        : null;
    }
    if (event.eventType === 'ATTEMPT_RESULT') {
      const plan = await this.deliverAttemptResult(event.attemptId);
      return plan?.operation === 'SEND_MESSAGE' && plan.chatId === event.chatId
        ? plan
        : null;
    }
    const attempt = await this.prisma.trainingAttempt.findFirst({
      where: {
        id: event.attemptId,
        userId: event.userId,
        status: TrainingAttemptStatus.TECHNICAL_FAILURE,
      },
      select: { id: true },
    });
    return attempt
      ? this.message(
          event.chatId,
          'Произошла техническая ошибка. Попытка передана администратору и не будет списана повторно.',
          this.platformKeyboard(),
        )
      : null;
  }

  private async processMessage(
    update: SanitizedTelegramMessageUpdate,
  ): Promise<DeliveryPlan[]> {
    if (
      update.content.kind === 'COMMAND' &&
      update.content.command === 'START' &&
      update.content.startTokenHash
    ) {
      try {
        await this.links.consumeHashedToken(
          update.content.startTokenHash,
          identityFromUpdate(update),
        );
        return [];
      } catch (error) {
        return [
          this.message(
            update.chatId,
            linkErrorMessage(error),
            this.platformKeyboard('Подключение аккаунта'),
          ),
        ];
      }
    }
    if (
      update.content.kind === 'COMMAND' &&
      update.content.command === 'START' &&
      update.content.invalidStartToken
    ) {
      return [
        this.message(
          update.chatId,
          'Ссылка подключения недействительна. Создайте новую ссылку в Platforma.',
          this.platformKeyboard('Подключение аккаунта'),
        ),
      ];
    }

    const account = await this.links.findAccountByTelegramUserId(
      BigInt(update.user.telegramUserId),
    );
    if (account && !canUseTrainingTelegram(account.user)) {
      await this.links.revokeInactiveAccount(account.id, account.userId);
      return [this.accessClosed(update.chatId)];
    }
    if (
      !account ||
      account.revokedAt ||
      account.chatId !== BigInt(update.chatId)
    ) {
      return [this.connectionRequired(update.chatId)];
    }

    if (update.content.kind === 'COMMAND') {
      return this.processCommand(
        update.content.command,
        account.userId,
        update.chatId,
      );
    }
    if (update.content.kind === 'REJECTED') {
      return [
        this.message(
          update.chatId,
          `Тип сообщения «${update.content.rejectedType}» не принимается. Ответ отправляется только как Telegram message.voice.`,
        ),
      ];
    }
    return this.processVoice(update, update.content, account.userId);
  }

  private async processCommand(
    command: Extract<
      SanitizedTelegramMessageUpdate['content'],
      { kind: 'COMMAND' }
    >['command'],
    userId: string,
    chatId: string,
  ): Promise<DeliveryPlan[]> {
    if (command === 'START') {
      return [
        this.message(
          chatId,
          'Аккаунт подключён. Выберите действие.',
          this.mainMenuKeyboard(),
        ),
      ];
    }
    if (command === 'CONNECT') {
      return [
        this.message(
          chatId,
          'Telegram уже подключён к вашему аккаунту Platforma.',
          this.mainMenuKeyboard(),
        ),
      ];
    }
    if (command === 'PROJECTS') return this.projectList(userId, chatId);
    if (command === 'RESULTS') return this.resultsList(userId, chatId);
    if (command === 'RULES') {
      return [await this.policyMessage(userId, chatId)];
    }
    if (command === 'OPEN_PLATFORM') {
      return [
        this.message(
          chatId,
          'Откройте раздел обучения в Platforma.',
          this.platformKeyboard(),
        ),
      ];
    }
    const active = await this.findActiveAttempt(userId);
    return [
      this.message(
        chatId,
        active
          ? 'Попытку нельзя отменить или поставить на паузу. Таймер продолжает идти.'
          : 'Активной попытки нет.',
        this.mainMenuKeyboard(),
      ),
    ];
  }

  private async processCallback(
    update: SanitizedTelegramCallbackUpdate,
  ): Promise<DeliveryPlan[]> {
    const answerPlan: DeliveryPlan = {
      operation: 'ANSWER_CALLBACK',
      callbackQueryId: update.callbackQueryId,
    };
    const account = await this.links.findAccountByTelegramUserId(
      BigInt(update.user.telegramUserId),
    );
    if (account && !canUseTrainingTelegram(account.user)) {
      await this.links.revokeInactiveAccount(account.id, account.userId);
      return [answerPlan, this.accessClosed(update.chatId)];
    }
    if (
      !account ||
      account.revokedAt ||
      account.chatId !== BigInt(update.chatId)
    ) {
      return [answerPlan, this.connectionRequired(update.chatId)];
    }
    const callback = parseTrainingTelegramCallback(update.callbackData);
    if (!callback) {
      return [
        { ...answerPlan, text: 'Кнопка устарела' },
        this.message(update.chatId, 'Эта кнопка больше не действует.'),
      ];
    }
    if (callback.action === 'PROJECTS') {
      return [answerPlan, ...(await this.projectList(account.userId, update.chatId))];
    }
    if (callback.action === 'RESULTS') {
      return [answerPlan, ...(await this.resultsList(account.userId, update.chatId))];
    }
    if (callback.action === 'RULES') {
      return [
        answerPlan,
        ...(await this.processCommand('RULES', account.userId, update.chatId)),
      ];
    }
    if (callback.action === 'CONNECT') {
      return [
        answerPlan,
        ...(await this.processCommand('CONNECT', account.userId, update.chatId)),
      ];
    }
    if (
      callback.action === 'POLICY_ACCEPT' ||
      callback.action === 'POLICY_ACCEPT_START'
    ) {
      try {
        if (!this.policy) {
          throw new ConflictException('Training policy is unavailable');
        }
        await this.policy.accept(
          account.userId,
          TrainingPolicyAcceptanceSource.TELEGRAM,
        );
        return callback.action === 'POLICY_ACCEPT_START'
          ? [
              { ...answerPlan, text: 'Правила приняты' },
              await this.projectConfirmation(
                account.userId,
                callback.projectId,
                update.chatId,
              ),
            ]
          : [
              { ...answerPlan, text: 'Правила приняты' },
              await this.policyMessage(account.userId, update.chatId),
            ];
      } catch (error) {
        return [
          { ...answerPlan, text: 'Не удалось сохранить подтверждение' },
          this.message(update.chatId, safeUserError(error)),
        ];
      }
    }
    if (callback.action === 'PROJECT') {
      try {
        return [
          answerPlan,
          await this.projectConfirmation(
            account.userId,
            callback.projectId,
            update.chatId,
          ),
        ];
      } catch (error) {
        return [
          { ...answerPlan, text: 'Проект недоступен' },
          this.message(update.chatId, safeUserError(error)),
        ];
      }
    }
    if (callback.action === 'START') {
      return [
        answerPlan,
        ...(await this.startAttempt(
          account.userId,
          callback.projectId,
          update.chatId,
          update.correlationId,
        )),
      ];
    }
    return [
      answerPlan,
      ...(await this.finishAnswer(
        account.userId,
        callback.attemptQuestionId,
        update.chatId,
        update.correlationId,
      )),
    ];
  }

  private async startAttempt(
    userId: string,
    projectId: string,
    chatId: string,
    correlationId?: string,
  ): Promise<DeliveryPlan[]> {
    const active = await this.findActiveAttempt(userId);
    if (active) {
      return [
        this.message(
          chatId,
          'У вас уже есть активная аттестация. Вторая попытка не создана.',
        ),
      ];
    }
    const currentPolicy = await this.policy?.getCurrentPolicy(userId);
    if (currentPolicy && !currentPolicy.accepted) {
      return [
        this.message(
          chatId,
          `${currentPolicy.policy.title}\nВерсия ${currentPolicy.policy.version}, действует с ${formatPolicyDate(currentPolicy.policy.effectiveAt)}.\n\n${currentPolicy.policy.body}`,
          {
            inline_keyboard: [
              [
                {
                  text: 'Ознакомлен и согласен продолжить',
                  callback_data: encodePolicyAcceptStartCallback(projectId),
                },
              ],
              [
                {
                  text: 'Открыть платформу',
                  url: this.config.publicTrainingUrl,
                },
              ],
            ],
          },
        ),
      ];
    }
    try {
      const result = await this.attempts.confirmStart({
        userId,
        projectId,
        confirmed: true,
        correlationId,
      });
      const question = currentQuestion(result.attempt);
      if (!question) {
        throw new ConflictException('Training attempt has no current question');
      }
      return [];
    } catch (error) {
      const recovered = await this.findActiveAttempt(userId);
      if (recovered) {
        return [
          this.message(
            chatId,
            'У вас уже есть активная аттестация. Вторая попытка не создана.',
          ),
        ];
      }
      return [this.message(chatId, safeUserError(error))];
    }
  }

  private async finishAnswer(
    userId: string,
    attemptQuestionId: string,
    chatId: string,
    correlationId?: string,
  ): Promise<DeliveryPlan[]> {
    const target = await this.prisma.trainingAttemptQuestion.findUnique({
      where: { id: attemptQuestionId },
      include: {
        attempt: { select: { id: true, userId: true } },
        answer: { select: { status: true } },
      },
    });
    if (!target || target.attempt.userId !== userId) {
      return [this.message(chatId, 'Ответ не найден или кнопка устарела.')];
    }
    if (
      target.status !== TrainingAttemptQuestionStatus.COLLECTING ||
      target.answer?.status !== TrainingAnswerStatus.COLLECTING
    ) {
      return [this.message(chatId, 'Этот ответ уже завершён.')];
    }
    try {
      await this.attempts.finishAnswer({
        attemptId: target.attempt.id,
        attemptQuestionId,
        correlationId,
      });
      return [];
    } catch (error) {
      return [this.message(chatId, safeUserError(error))];
    }
  }

  private async processVoice(
    update: SanitizedTelegramMessageUpdate,
    voice: Extract<
      SanitizedTelegramMessageUpdate['content'],
      { kind: 'VOICE' }
    >,
    userId: string,
  ): Promise<DeliveryPlan[]> {
    const active = await this.findActiveAttempt(userId);
    if (!active) {
      const latestAttempt = await this.prisma.trainingAttempt.findFirst({
        where: { userId },
        orderBy: { startedAt: 'desc' },
        select: { expiresAt: true },
      });
      if (
        latestAttempt &&
        new Date(update.receivedAt) >= latestAttempt.expiresAt
      ) {
        return [
          this.message(
            update.chatId,
            'Время ответа истекло. Новые голосовые части не принимаются.',
          ),
        ];
      }
      return [
        this.message(
          update.chatId,
          'Сначала выберите проект и подтвердите начало аттестации.',
          this.projectsKeyboard(),
        ),
      ];
    }
    try {
      const beforeQuestion = currentQuestion(active);
      if (!beforeQuestion) {
        return [this.message(update.chatId, 'Попытка уже завершается.')];
      }
      const result = await this.attempts.appendVoiceSegment({
        attemptId: active.id,
        kind: 'VOICE',
        updateId: BigInt(update.updateId),
        fakeTranscript: voice.fileUniqueId.slice(0, 220),
        recordingStartedAt: new Date(voice.recordingStartedAt),
        receivedAt: new Date(update.receivedAt),
        durationSeconds: voice.durationSeconds,
        telegramMessageId: BigInt(update.messageId),
        telegramChatId: BigInt(update.chatId),
        telegramFileId: voice.fileId,
        fileUniqueId: voice.fileUniqueId,
        correlationId: update.correlationId,
        sizeBytes: voice.sizeBytes
          ? BigInt(voice.sizeBytes)
          : undefined,
      });
      const segment = await this.prisma.trainingVoiceSegment.findUnique({
        where: {
          telegramChatId_telegramMessageId: {
            telegramChatId: BigInt(update.chatId),
            telegramMessageId: BigInt(update.messageId),
          },
        },
        select: {
          segmentIndex: true,
          answer: {
            select: {
              attemptQuestionId: true,
              status: true,
            },
          },
        },
      });
      if (!segment) {
        throw new ConflictException('Voice segment was not persisted');
      }
      if (segment.answer.status !== TrainingAnswerStatus.COLLECTING) {
        return [this.message(update.chatId, 'Ответ принят')];
      }
      const stillCurrent = currentQuestion(result.attempt);
      if (!stillCurrent || stillCurrent.id !== segment.answer.attemptQuestionId) {
        return [this.message(update.chatId, 'Ответ принят')];
      }
      return [
        this.message(
          update.chatId,
          `Часть ${segment.segmentIndex} принята. Отправьте ещё голосовую часть или завершите ответ.`,
          {
            inline_keyboard: [
              [
                {
                  text: 'Завершить ответ',
                  callback_data: encodeFinishCallback(
                    segment.answer.attemptQuestionId,
                  ),
                },
              ],
            ],
          },
        ),
      ];
    } catch (error) {
      return [this.message(update.chatId, safeUserError(error))];
    }
  }

  private async projectList(userId: string, chatId: string) {
    const projects = await this.listOpenProjects(userId);
    if (projects.length === 0) {
      return [
        this.message(
          chatId,
          'Сейчас нет открытых администратором проектов.',
          this.mainMenuKeyboard(),
        ),
      ];
    }
    return [
      this.message(chatId, 'Выберите проект:', {
        inline_keyboard: projects.map((project) => [
          {
            text: project.title,
            callback_data: encodeProjectCallback(project.id),
          },
        ]),
      }),
    ];
  }

  private async projectConfirmation(
    userId: string,
    projectId: string,
    chatId: string,
  ): Promise<DeliveryPlan> {
    const project = await this.getOpenProject(userId, projectId);
    const attemptsUsed = await this.prisma.trainingAttempt.count({
      where: { userId, projectId, isConsumed: true },
    });
    const attemptsLeft = Math.max(
      0,
      project.activeVersion!.attemptLimit - attemptsUsed,
    );
    return this.message(
      chatId,
      `${project.title}\n\nПосле подтверждения попытка будет списана немедленно. На весь экзамен отведено ${formatSeconds(
        project.activeVersion!.totalTimeLimitSeconds,
      )}. Экзамен нельзя поставить на паузу или продолжить позже.\nОсталось попыток: ${attemptsLeft}.`,
      {
        inline_keyboard: [
          [
            {
              text: 'Начать аттестацию',
              callback_data: encodeStartCallback(project.id),
            },
          ],
          [{ text: 'Выбор проекта', callback_data: 'tr:projects' }],
        ],
      },
    );
  }

  private async resultsList(userId: string, chatId: string) {
    const attempts = await this.prisma.trainingAttempt.findMany({
      where: {
        userId,
        completedAt: { not: null },
        status: {
          in: [
            TrainingAttemptStatus.COMPLETED,
            TrainingAttemptStatus.REQUIRES_REVIEW,
          ],
        },
      },
      include: {
        project: { select: { title: true } },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    });
    if (attempts.length === 0) {
      return [
        this.message(
          chatId,
          'Завершённых аттестаций пока нет.',
          this.mainMenuKeyboard(),
        ),
      ];
    }
    const lines = attempts.map((attempt) => {
      if (
        attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW ||
        attempt.reviewStatus === TrainingReviewStatus.PENDING
      ) {
        return `${attempt.project.title}: результат отправлен на проверку`;
      }
      return `${attempt.project.title}: ${formatScore(attempt.finalScore)}/100 — ${
        attempt.passStatus === TrainingPassStatus.PASSED
          ? 'сдано'
          : 'не сдано'
      }`;
    });
    return [
      this.message(
        chatId,
        `Мои результаты:\n${lines.join('\n')}`,
        this.mainMenuKeyboard(),
      ),
    ];
  }

  private async findActiveAttempt(userId: string) {
    return this.prisma.trainingAttempt.findFirst({
      where: {
        userId,
        status: { in: [...TRAINING_ACTIVE_ATTEMPT_STATUSES] },
      },
      include: {
        attemptQuestions: {
          orderBy: { sequence: 'asc' },
          include: {
            question: true,
            answer: {
              include: {
                voiceSegments: { orderBy: { segmentIndex: 'asc' } },
              },
            },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });
  }

  private async listOpenProjects(userId: string) {
    const now = new Date();
    return this.prisma.trainingProject.findMany({
      where: {
        status: TrainingProjectStatus.OPEN,
        activeVersion: { status: TrainingVersionStatus.PUBLISHED },
        ...trainingProjectAudienceWhere(userId),
        AND: [
          { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
          { OR: [{ deadlineAt: null }, { deadlineAt: { gte: now } }] },
        ],
      },
      include: {
        activeVersion: true,
      },
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    });
  }

  private async getOpenProject(userId: string, projectId: string) {
    const projects = await this.listOpenProjects(userId);
    const project = projects.find((item) => item.id === projectId);
    if (!project) throw new NotFoundException('Open training project not found');
    return project;
  }

  private async policyMessage(userId: string, chatId: string) {
    const currentPolicy = this.policy
      ? await this.policy.getCurrentPolicy(userId)
      : {
          policy: {
            ...CURRENT_TRAINING_POLICY,
            id: 'unavailable',
          },
          accepted: false,
          acceptance: null,
        };
    return this.message(
      chatId,
      `${currentPolicy.policy.title}\nВерсия ${currentPolicy.policy.version}, действует с ${formatPolicyDate(currentPolicy.policy.effectiveAt)}.\n\n${currentPolicy.policy.body}\n\n${
        currentPolicy.accepted
          ? `Подтверждено: ${formatPolicyDate(currentPolicy.acceptance!.acceptedAt)}.`
          : 'Для начала аттестации подтвердите ознакомление.'
      }`,
      currentPolicy.accepted
        ? this.mainMenuKeyboard()
        : {
            inline_keyboard: [
              [
                {
                  text: 'Ознакомлен и согласен продолжить',
                  callback_data: 'tr:accept',
                },
              ],
              [
                {
                  text: 'Открыть платформу',
                  url: this.config.publicTrainingUrl,
                },
              ],
            ],
          },
    );
  }

  private async enqueueDeliveryPlans(
    originKey: string,
    correlationId: string,
    plans: DeliveryPlan[],
  ) {
    if (plans.length === 0) return;
    const now = new Date();
    await this.prisma.trainingJob.createMany({
      data: plans.map((plan, index) => ({
        kind: TrainingJobKind.SEND_TELEGRAM_MESSAGE,
        status: TrainingJobStatus.PENDING,
        payloadJson: {
          ...plan,
          correlationId,
        } as unknown as Prisma.InputJsonObject,
        idempotencyKey: `${originKey}:delivery:${index}`,
        runAt: new Date(now.getTime() + index),
        maxAttempts: 5,
      })),
      skipDuplicates: true,
    });
  }

  private message(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboard,
  ): DeliveryPlan {
    return {
      operation: 'SEND_MESSAGE',
      chatId,
      text,
      ...(replyMarkup ? { replyMarkup } : {}),
    };
  }

  private questionMessage(
    chatId: string,
    question: {
      sequence: number;
      question: { text: string };
    },
  ) {
    return this.message(
      chatId,
      `Вопрос ${question.sequence} из 4:\n${question.question.text}\n\nОтправьте ответ голосовым сообщением.`,
    );
  }

  private connectionRequired(chatId: string) {
    return this.message(
      chatId,
      'Подключите Telegram к существующему аккаунту Platforma по одноразовой ссылке.',
      this.platformKeyboard('Подключение аккаунта'),
    );
  }

  private accessClosed(chatId: string) {
    return this.message(
      chatId,
      'Доступ к обучению закрыт. Обратитесь к администратору Platforma.',
    );
  }

  private mainMenuKeyboard(): TelegramInlineKeyboard {
    return {
      inline_keyboard: [
        [{ text: 'Выбор проекта', callback_data: 'tr:projects' }],
        [{ text: 'Мои результаты', callback_data: 'tr:results' }],
        [{ text: 'Правила', callback_data: 'tr:rules' }],
        [{ text: 'Открыть платформу', url: this.config.publicTrainingUrl }],
      ],
    };
  }

  private projectsKeyboard(): TelegramInlineKeyboard {
    return {
      inline_keyboard: [
        [{ text: 'Выбор проекта', callback_data: 'tr:projects' }],
        [{ text: 'Открыть платформу', url: this.config.publicTrainingUrl }],
      ],
    };
  }

  private platformKeyboard(label = 'Открыть платформу'): TelegramInlineKeyboard {
    return {
      inline_keyboard: [
        [{ text: label, url: this.config.publicTrainingUrl }],
      ],
    };
  }
}

function identityFromUpdate(
  update: SanitizedTelegramMessageUpdate,
): TrainingTelegramIdentity {
  return {
    telegramUserId: BigInt(update.user.telegramUserId),
    chatId: BigInt(update.chatId),
    username: update.user.username,
    firstName: update.user.firstName,
    lastName: update.user.lastName,
  };
}

function currentQuestion<T extends {
  attemptQuestions: Array<{
    id: string;
    sequence: number;
    status: TrainingAttemptQuestionStatus;
    question: { text: string };
  }>;
}>(attempt: T) {
  return attempt.attemptQuestions.find(
    (question) =>
      question.status === TrainingAttemptQuestionStatus.PRESENTED ||
      question.status === TrainingAttemptQuestionStatus.COLLECTING,
  );
}

function formatScore(value: Prisma.Decimal | null) {
  return value ? value.toFixed(2).replace(/\.00$/u, '') : '0';
}

function formatSeconds(seconds: number) {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${russianPlural(minutes, 'минута', 'минуты', 'минут')}`;
  }
  return `${seconds} ${russianPlural(seconds, 'секунда', 'секунды', 'секунд')}`;
}

function russianPlural(
  value: number,
  singular: string,
  few: string,
  many: string,
) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return singular;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function linkErrorMessage(error: unknown) {
  if (error instanceof HttpException) {
    const message = error.message.toLocaleLowerCase('ru-RU');
    if (message.includes('not active')) {
      return 'Доступ к обучению закрыт. Обратитесь к администратору Platforma.';
    }
    if (message.includes('expired')) {
      return 'Срок действия ссылки истёк. Создайте новую ссылку в Platforma.';
    }
    if (message.includes('already used')) {
      return 'Ссылка уже использована. Создайте новую ссылку в Platforma.';
    }
    if (message.includes('revoked')) {
      return 'Ссылка отозвана. Создайте новую ссылку в Platforma.';
    }
    if (error instanceof ConflictException) {
      return 'Не удалось подключить аккаунт из-за конфликта привязки. Отключите текущую связь в Platforma или обратитесь к администратору.';
    }
  }
  return 'Ссылка подключения недействительна. Создайте новую ссылку в Platforma.';
}

function canUseTrainingTelegram(user: {
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

function formatPolicyDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function safeUserError(error: unknown) {
  if (error instanceof BadRequestException) {
    if (error.message.includes('Only voice')) {
      return 'Принимаются только голосовые сообщения Telegram (message.voice).';
    }
    if (error.message.includes('no voice segments')) {
      return 'Сначала отправьте голосовую часть ответа.';
    }
  }
  if (error instanceof ConflictException) {
    if (
      error.message.includes('grace') ||
      error.message.includes('recording started') ||
      error.message.includes('finaliz')
    ) {
      return 'Время ответа истекло. Новые голосовые части не принимаются.';
    }
    if (error.message.includes('no longer current')) {
      return 'Этот ответ уже завершён.';
    }
    return error.message;
  }
  if (error instanceof NotFoundException) return error.message;
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

function serializeEmployeeAttempt(attempt: {
  id: string;
  attemptNumber: number;
  status: TrainingAttemptStatus;
  isConsumed: boolean;
  startedAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  finalScore: Prisma.Decimal | null;
  passStatus: TrainingPassStatus;
  reviewStatus: TrainingReviewStatus;
  project: { id: string; title: string; slug: string };
}) {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    isConsumed: attempt.isConsumed,
    startedAt: attempt.startedAt.toISOString(),
    expiresAt: attempt.expiresAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
    finalScore:
      attempt.reviewStatus === TrainingReviewStatus.PENDING
        ? null
        : attempt.finalScore?.toString() ?? null,
    passStatus: attempt.passStatus,
    reviewStatus: attempt.reviewStatus,
    project: attempt.project,
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingAnswerProcessingStatus,
  TrainingAttemptQuestionStatus,
  TrainingAttemptStatus,
  UserStatus,
} from '@prisma/client';
import type {
  TrainingTelegramAccountState,
  TrainingTelegramLinkResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../prisma/prisma.service';
import { TrainingAttemptStateService } from './training-attempt-state.service';
import { TrainingAttemptService } from './training-attempt.service';
import {
  getTrainingTelegramTransportMode,
  TRAINING_TELEGRAM_CLIENT,
  type TrainingTelegramClient,
} from './training-telegram-client';

const TELEGRAM_LINK_TTL_MS = 15 * 60 * 1000;
const TELEGRAM_MAX_UPDATE_BYTES = 64 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TelegramIdentity = {
  telegramUserId: bigint;
  chatId: bigint;
  username: string | null;
};

type TelegramMessage = {
  messageId: bigint;
  identity: TelegramIdentity;
  text: string | null;
  voice: {
    fileId: string;
    fileUniqueId: string;
    durationSeconds: number;
    sizeBytes: bigint | null;
  } | null;
};

type TelegramCallback = {
  id: string;
  identity: TelegramIdentity;
  data: string;
};

type TrainingTelegramDelivery = () => Promise<void>;

@Injectable()
export class TrainingTelegramService {
  private readonly outboundContext = new AsyncLocalStorage<TrainingTelegramClient>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly attemptState: TrainingAttemptStateService,
    private readonly attempts: TrainingAttemptService,
    @Inject(TRAINING_TELEGRAM_CLIENT) private readonly client: TrainingTelegramClient,
  ) {}

  get maxUpdateBytes() {
    return TELEGRAM_MAX_UPDATE_BYTES;
  }

  async handleWebhookUpdate(update: unknown) {
    const deliveries: TrainingTelegramDelivery[] = [];
    const deferredClient: TrainingTelegramClient = {
      sendMessage: async (input) => {
        const copiedInput = {
          ...input,
          inlineKeyboard: input.inlineKeyboard?.map((row) =>
            row.map((button) => ({ ...button })),
          ),
        };
        deliveries.push(() => this.client.sendMessage(copiedInput));
      },
      answerCallbackQuery: async (callbackQueryId, text) => {
        deliveries.push(() => this.client.answerCallbackQuery(callbackQueryId, text));
      },
      getFile: async () => {
        throw new Error('Telegram file download is not allowed in a webhook request');
      },
      downloadFile: async () => {
        throw new Error('Telegram file download is not allowed in a webhook request');
      },
    };

    await this.outboundContext.run(deferredClient, () => this.handleUpdate(update));
    return deliveries;
  }

  dispatchWebhookDeliveries(deliveries: TrainingTelegramDelivery[]) {
    queueMicrotask(async () => {
      for (const deliver of deliveries) {
        await deliver().catch(() => undefined);
      }
    });
  }

  private get outboundClient() {
    return this.outboundContext.getStore() ?? this.client;
  }

  async getAccountState(userId: string): Promise<TrainingTelegramAccountState> {
    const account = await this.prisma.trainingTelegramAccount.findFirst({
      where: { userId, revokedAt: null },
      select: { username: true, linkedAt: true },
    });

    return serializeAccountState(account);
  }

  async createProjectLink(
    userId: string,
    projectId: string,
  ): Promise<TrainingTelegramLinkResponse> {
    const projects = await this.attempts.listEmployeeProjects(userId);
    const project = projects.items.find((item) => item.id === projectId);

    if (!project) {
      throw new NotFoundException('Training project not found');
    }

    if (!project.canStart && !project.activeAttempt) {
      throw new ConflictException('Training project is not available');
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = hashTrainingTelegramLinkToken(rawToken);
    const now = await this.getDatabaseNow();
    const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_TTL_MS);

    await this.prisma.trainingTelegramLinkToken.create({
      data: { userId, projectId, tokenHash, expiresAt },
    });

    const username = getTelegramBotUsername();
    const url = new URL(`https://t.me/${username}`);
    url.searchParams.set('start', rawToken);

    return {
      url: url.toString(),
      expiresAt: expiresAt.toISOString(),
      account: await this.getAccountState(userId),
    };
  }

  assertWebhookSecret(value: string | undefined) {
    const expected = getWebhookSecret();
    const actualBuffer = Buffer.from(value ?? '', 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new ForbiddenException('Invalid Telegram webhook secret');
    }
  }

  async handleUpdate(update: unknown) {
    if (!isPrivateTrainingTelegramUpdate(update)) return;

    const callback = parseTelegramCallback(update);

    if (callback) {
      await this.handleCallback(callback);
      return;
    }

    const message = parseTelegramMessage(update);

    if (!message) return;

    const startToken = parseStartToken(message.text);

    if (startToken !== undefined) {
      if (startToken) {
        await this.handleStartToken(message.identity, startToken);
      } else {
        await this.sendResumeState(message.identity);
      }
      return;
    }

    if (message.voice) {
      await this.handleVoice(message);
      return;
    }

    const context = await this.resolveDialogContext(message.identity);

    if (context?.attemptId) {
      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text: 'Ответ отправьте голосовым сообщением',
      });
    }
  }

  async notifyAnswerProcessed(answerId: string) {
    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: {
        attemptQuestion: {
          select: {
            attempt: {
              select: {
                id: true,
                userId: true,
              },
            },
          },
        },
      },
    });

    if (!answer) return;

    const account = await this.prisma.trainingTelegramAccount.findFirst({
      where: {
        userId: answer.attemptQuestion.attempt.userId,
        revokedAt: null,
      },
      select: { chatId: true },
    });

    if (!account) return;

    await this.sendAttemptState(account.chatId, answer.attemptQuestion.attempt.id);
  }

  async notifyAnswerFailed(answerId: string) {
    const answer = await this.prisma.trainingAnswer.findUnique({
      where: { id: answerId },
      select: {
        attemptQuestion: {
          select: { attempt: { select: { userId: true } } },
        },
      },
    });

    if (!answer) return;

    const account = await this.prisma.trainingTelegramAccount.findFirst({
      where: { userId: answer.attemptQuestion.attempt.userId, revokedAt: null },
      select: { chatId: true },
    });

    if (account) {
      await this.outboundClient.sendMessage({
        chatId: account.chatId,
        text: 'Не удалось обработать голосовой ответ. Попытка не получила обычную оценку.',
      });
    }
  }

  private async handleStartToken(identity: TelegramIdentity, rawToken: string) {
    try {
      const linked = await this.consumeLinkToken(rawToken, identity);

      await this.outboundClient.sendMessage({
        chatId: identity.chatId,
        text: `Проект «${linked.projectTitle}» выбран. Попытка будет списана только после подтверждения.`,
        inlineKeyboard: [
          [
            {
              text: 'Начать аттестацию',
              callbackData: `tr:start:${linked.tokenId}`,
            },
          ],
        ],
      });
    } catch (error) {
      await this.outboundClient.sendMessage({
        chatId: identity.chatId,
        text: getSafeLinkErrorMessage(error),
      });
    }
  }

  private async handleCallback(callback: TelegramCallback) {
    const parsed = parseTrainingTelegramCallback(callback.data);

    if (!parsed) {
      await this.outboundClient.answerCallbackQuery(callback.id, 'Действие устарело');
      return;
    }

    try {
      if (parsed.kind === 'START') {
        await this.handleStartCallback(callback, parsed.id);
      } else {
        await this.handleFinishCallback(callback, parsed.id);
      }
    } catch (error) {
      if (
        !(
          error instanceof BadRequestException ||
          error instanceof ConflictException ||
          error instanceof NotFoundException
        )
      ) {
        throw error;
      }

      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Действие недоступно. Отправьте /start, чтобы восстановить текущее состояние.',
      });
    } finally {
      await this.outboundClient.answerCallbackQuery(callback.id).catch(() => undefined);
    }
  }

  private async handleStartCallback(callback: TelegramCallback, tokenId: string) {
    const token = await this.prisma.trainingTelegramLinkToken.findUnique({
      where: { id: tokenId },
      select: {
        userId: true,
        usedAt: true,
        user: {
          select: {
            trainingTelegramAccounts: {
              where: { revokedAt: null },
              select: { telegramUserId: true, chatId: true },
            },
          },
        },
      },
    });
    const account = token?.user.trainingTelegramAccounts[0];

    if (
      !token ||
      token.usedAt === null ||
      !account ||
      account.telegramUserId !== callback.identity.telegramUserId ||
      account.chatId !== callback.identity.chatId
    ) {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Эта кнопка недоступна для текущего Telegram-аккаунта.',
      });
      return;
    }

    const attemptId = await this.attemptState.startAttemptFromTelegramLinkToken(
      tokenId,
      token.userId,
    );

    if (attemptId) {
      await this.sendAttemptState(callback.identity.chatId, attemptId);
    } else {
      await this.sendResumeState(callback.identity);
    }
  }

  private async handleFinishCallback(callback: TelegramCallback, attemptQuestionId: string) {
    const account = await this.findAccount(callback.identity);

    if (!account) {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Откройте Platforma и заново выберите проект.',
      });
      return;
    }

    const question = await this.prisma.trainingAttemptQuestion.findFirst({
      where: {
        id: attemptQuestionId,
        attempt: {
          userId: account.userId,
          status: TrainingAttemptStatus.IN_PROGRESS,
        },
      },
      select: { attemptId: true },
    });

    if (!question) {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Этот вопрос уже завершён или кнопка устарела.',
      });
      return;
    }

    const result = await this.attemptState.finishTelegramVoiceAnswer(
      question.attemptId,
      account.userId,
      attemptQuestionId,
    );

    if (result.status === 'PROCESSING') {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Ответ обрабатывается',
      });
    } else if (result.status === 'TIMED_OUT') {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Время попытки истекло. Аттестация не пройдена.',
      });
    } else if (result.status === 'NO_SEGMENTS') {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Сначала отправьте голосовое сообщение.',
      });
    } else if (result.status === 'FAILED') {
      await this.notifyAnswerFailed(result.answerId);
    } else {
      await this.outboundClient.sendMessage({
        chatId: callback.identity.chatId,
        text: 'Этот вопрос уже завершён или кнопка устарела.',
      });
    }
  }

  private async handleVoice(message: TelegramMessage) {
    const context = await this.resolveDialogContext(message.identity);

    if (!context?.attemptId || !message.voice) {
      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text: 'Откройте Platforma и выберите проект для аттестации.',
      });
      return;
    }

    let result;

    try {
      result = await this.attemptState.addTelegramVoiceSegment(
        context.attemptId,
        context.userId,
        {
          telegramMessageId: message.messageId,
          telegramFileId: message.voice.fileId,
          telegramFileUniqueId: message.voice.fileUniqueId,
          durationSeconds: message.voice.durationSeconds,
          sizeBytes: message.voice.sizeBytes,
        },
      );
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;

      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text: 'Голосовой ответ превышает допустимый лимит.',
      });
      return;
    }

    if (result.status === 'ADDED' || result.status === 'DUPLICATE') {
      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text:
          result.status === 'ADDED'
            ? 'Голосовое сообщение добавлено. Можно отправить ещё или завершить ответ.'
            : 'Это голосовое сообщение уже добавлено.',
        inlineKeyboard: [
          [
            {
              text: 'Завершить ответ',
              callbackData: `tr:finish:${result.attemptQuestionId}`,
            },
          ],
        ],
      });
    } else if (result.status === 'PROCESSING') {
      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text: 'Ответ уже обрабатывается',
      });
    } else if (result.status === 'FAILED') {
      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text: 'Не удалось обработать голосовой ответ. Новые сообщения для вопроса не принимаются.',
      });
    } else if (result.status === 'TIMED_OUT') {
      await this.outboundClient.sendMessage({
        chatId: message.identity.chatId,
        text: 'Время попытки истекло. Аттестация не пройдена.',
      });
    }
  }

  private async consumeLinkToken(rawToken: string, identity: TelegramIdentity) {
    const tokenHash = hashTrainingTelegramLinkToken(rawToken);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT "id" FROM "training_telegram_link_tokens" WHERE "token_hash" = ${tokenHash} FOR UPDATE`,
        );
        const token = await transaction.trainingTelegramLinkToken.findUnique({
          where: { tokenHash },
          include: {
            project: { select: { title: true } },
            user: {
              select: {
                id: true,
                status: true,
                deletedAt: true,
                role: {
                  select: {
                    permissions: {
                      select: { permission: { select: { key: true } } },
                    },
                  },
                },
              },
            },
          },
        });
        const now = await getTransactionNow(transaction);

        if (
          !token ||
          token.usedAt !== null ||
          token.revokedAt !== null ||
          token.expiresAt.getTime() <= now.getTime()
        ) {
          throw new ConflictException('Ссылка недействительна, истекла или уже использована.');
        }

        if (
          token.user.status !== UserStatus.ACTIVE ||
          token.user.deletedAt !== null ||
          !token.user.role.permissions.some(
            (rolePermission) => rolePermission.permission.key === 'training:participate',
          )
        ) {
          throw new ForbiddenException('Пользователь больше не имеет доступа к обучению.');
        }

        const activeAccounts = await transaction.trainingTelegramAccount.findMany({
          where: {
            revokedAt: null,
            OR: [
              { userId: token.userId },
              { telegramUserId: identity.telegramUserId },
            ],
          },
        });
        const accountForUser = activeAccounts.find((account) => account.userId === token.userId);
        const accountForTelegram = activeAccounts.find(
          (account) => account.telegramUserId === identity.telegramUserId,
        );

        if (accountForUser && accountForUser.telegramUserId !== identity.telegramUserId) {
          throw new ConflictException('Пользователь уже связан с другим Telegram-аккаунтом.');
        }

        if (accountForTelegram && accountForTelegram.userId !== token.userId) {
          throw new ConflictException('Этот Telegram уже связан с другим пользователем.');
        }

        if (accountForUser) {
          await transaction.trainingTelegramAccount.update({
            where: { id: accountForUser.id },
            data: {
              chatId: identity.chatId,
              username: identity.username,
            },
          });
        } else {
          await transaction.trainingTelegramAccount.create({
            data: {
              userId: token.userId,
              telegramUserId: identity.telegramUserId,
              chatId: identity.chatId,
              username: identity.username,
              linkedAt: now,
            },
          });
        }

        await transaction.trainingTelegramLinkToken.update({
          where: { id: token.id },
          data: { usedAt: now },
        });

        return {
          tokenId: token.id,
          projectTitle: token.project.title,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Telegram-аккаунт уже связан с другим пользователем.');
      }

      throw error;
    }
  }

  private async sendResumeState(identity: TelegramIdentity) {
    const context = await this.resolveDialogContext(identity);

    if (!context) {
      await this.outboundClient.sendMessage({
        chatId: identity.chatId,
        text: 'Откройте Platforma и выберите проект для аттестации.',
      });
      return;
    }

    if (context.attemptId) {
      await this.sendAttemptState(identity.chatId, context.attemptId);
      return;
    }

      await this.outboundClient.sendMessage({
      chatId: identity.chatId,
      text: 'Откройте Platforma и выберите проект для аттестации.',
    });
  }

  private async sendAttemptState(chatId: bigint, attemptId: string) {
    await this.attemptState.finalizeAttemptIfExpired(attemptId);
    const attempt = await this.prisma.trainingAttempt.findUnique({
      where: { id: attemptId },
      include: {
        questions: {
          include: {
            answer: { include: { _count: { select: { segments: true } } } },
          },
          orderBy: { sequence: 'asc' },
        },
      },
    });

    if (!attempt) return;

    if (attempt.status === TrainingAttemptStatus.TIMED_OUT) {
      await this.outboundClient.sendMessage({
        chatId,
        text: 'Время попытки истекло. Аттестация не пройдена.',
      });
      return;
    }

    if (attempt.status === TrainingAttemptStatus.COMPLETED) {
      await this.outboundClient.sendMessage({
        chatId,
        text: attempt.isPassed ? 'Аттестация пройдена.' : 'Аттестация не пройдена.',
      });
      return;
    }

    if (attempt.status === TrainingAttemptStatus.REQUIRES_REVIEW) {
      await this.outboundClient.sendMessage({
        chatId,
        text: 'Результат требует проверки.',
      });
      return;
    }

    const question = attempt.questions.find(
      (item) => item.status === TrainingAttemptQuestionStatus.PRESENTED,
    );

    if (!question) {
      await this.outboundClient.sendMessage({ chatId, text: 'Текущее состояние обновляется.' });
      return;
    }

    if (question.answer?.processingStatus === TrainingAnswerProcessingStatus.PROCESSING) {
      await this.outboundClient.sendMessage({ chatId, text: 'Ответ обрабатывается' });
      return;
    }

    if (question.answer?.processingStatus === TrainingAnswerProcessingStatus.FAILED) {
      await this.outboundClient.sendMessage({
        chatId,
        text: 'Не удалось обработать голосовой ответ. Попытка не получила обычную оценку.',
      });
      return;
    }

      await this.outboundClient.sendMessage({
      chatId,
      text: `Вопрос ${question.sequence} из 4\n${question.questionTextSnapshot}\n\nОтправьте ответ голосовым сообщением.`,
      ...(question.answer?._count.segments
        ? {
            inlineKeyboard: [
              [
                {
                  text: 'Завершить ответ',
                  callbackData: `tr:finish:${question.id}`,
                },
              ],
            ],
          }
        : {}),
    });
  }

  private async resolveDialogContext(identity: TelegramIdentity) {
    const account = await this.findAccount(identity);

    if (!account) return null;

    await this.attemptState.finalizeExpiredForUser(account.userId);
    const selectedToken = await this.prisma.trainingTelegramLinkToken.findFirst({
      where: { userId: account.userId, usedAt: { not: null } },
      orderBy: [{ usedAt: 'desc' }, { createdAt: 'desc' }],
      select: { projectId: true },
    });
    const activeAttempts = await this.prisma.trainingAttempt.findMany({
      where: { userId: account.userId, status: TrainingAttemptStatus.IN_PROGRESS },
      orderBy: { startedAt: 'desc' },
      select: { id: true, projectId: true },
    });
    const selectedAttempt = selectedToken
      ? activeAttempts.find((attempt) => attempt.projectId === selectedToken.projectId)
      : null;
    const attempt = selectedAttempt ?? (activeAttempts.length === 1 ? activeAttempts[0] : null);

    return { userId: account.userId, attemptId: attempt?.id ?? null };
  }

  private findAccount(identity: TelegramIdentity) {
    return this.prisma.trainingTelegramAccount.findFirst({
      where: {
        telegramUserId: identity.telegramUserId,
        chatId: identity.chatId,
        revokedAt: null,
      },
      select: { userId: true },
    });
  }

  private async getDatabaseNow() {
    const [row] = await this.prisma.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
    );

    if (!row) throw new Error('Database timestamp unavailable');
    return row.now;
  }
}

export function hashTrainingTelegramLinkToken(rawToken: string) {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function parseTrainingTelegramCallback(value: string) {
  const match = /^(tr:start|tr:finish):([0-9a-f-]{36})$/iu.exec(value);

  if (!match || !uuidPattern.test(match[2] ?? '')) return null;

  return {
    kind: match[1] === 'tr:start' ? ('START' as const) : ('FINISH' as const),
    id: match[2] ?? '',
  };
}

export function isPrivateTrainingTelegramUpdate(update: unknown) {
  if (!isRecord(update)) return false;
  const message = isRecord(update.message) ? update.message : null;
  const callback = isRecord(update.callback_query) ? update.callback_query : null;
  const callbackMessage = callback && isRecord(callback.message) ? callback.message : null;
  const chat = message && isRecord(message.chat)
    ? message.chat
    : callbackMessage && isRecord(callbackMessage.chat)
      ? callbackMessage.chat
      : null;

  return chat?.type === 'private';
}

function parseTelegramMessage(update: unknown): TelegramMessage | null {
  if (!isRecord(update) || !isRecord(update.message)) return null;
  const message = update.message;
  const identity = parseIdentity(message.from, message.chat);
  const messageId = parseSafeInteger(message.message_id);

  if (!identity || messageId === null) return null;

  let voice: TelegramMessage['voice'] = null;

  if (isRecord(message.voice)) {
    const fileId = parseBoundedText(message.voice.file_id, 512);
    const fileUniqueId = parseBoundedText(message.voice.file_unique_id, 512);
    const durationSeconds = parseSafeInteger(message.voice.duration);
    const sizeBytes = parseOptionalSafeInteger(message.voice.file_size);

    if (
      fileId &&
      fileUniqueId &&
      durationSeconds !== null &&
      durationSeconds >= 0 &&
      (sizeBytes === null || sizeBytes > 0)
    ) {
      voice = {
        fileId,
        fileUniqueId,
        durationSeconds,
        sizeBytes: sizeBytes === null ? null : BigInt(sizeBytes),
      };
    }
  }

  return {
    messageId: BigInt(messageId),
    identity,
    text: typeof message.text === 'string' ? message.text : null,
    voice,
  };
}

function parseTelegramCallback(update: unknown): TelegramCallback | null {
  if (!isRecord(update) || !isRecord(update.callback_query)) return null;
  const callback = update.callback_query;
  const message = isRecord(callback.message) ? callback.message : null;
  const identity = parseIdentity(callback.from, message?.chat);
  const id = parseBoundedText(callback.id, 128);
  const data = parseBoundedText(callback.data, 64);

  return identity && id && data ? { id, identity, data } : null;
}

function parseIdentity(fromValue: unknown, chatValue: unknown): TelegramIdentity | null {
  if (!isRecord(fromValue) || !isRecord(chatValue) || chatValue.type !== 'private') return null;
  const telegramUserId = parseSafeInteger(fromValue.id);
  const chatId = parseSafeInteger(chatValue.id);

  if (telegramUserId === null || chatId === null) return null;

  return {
    telegramUserId: BigInt(telegramUserId),
    chatId: BigInt(chatId),
    username: parseBoundedText(fromValue.username, 64),
  };
}

function parseStartToken(text: string | null) {
  if (text === null) return undefined;
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{20,64}))?\s*$/u.exec(text);

  if (!match) return undefined;
  return match[1] ?? '';
}

function parseSafeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function parseOptionalSafeInteger(value: unknown) {
  return value === undefined ? null : parseSafeInteger(value);
}

function parseBoundedText(value: unknown, maximumLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTelegramBotUsername() {
  const value = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/u, '');

  if (value && /^[A-Za-z0-9_]{5,32}$/u.test(value)) return value;
  if (getTrainingTelegramTransportMode() === 'fake') return 'platforma_training_bot';

  throw new Error('TELEGRAM_BOT_USERNAME is invalid');
}

function getWebhookSecret() {
  const value = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

  if (value) return value;
  if (getTrainingTelegramTransportMode() === 'fake') {
    return 'training-v2-fake-webhook-secret';
  }

  throw new Error('TELEGRAM_WEBHOOK_SECRET is required');
}

function getSafeLinkErrorMessage(error: unknown) {
  if (
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof BadRequestException
  ) {
    return error.message;
  }

  return 'Не удалось использовать ссылку. Создайте новую ссылку в Platforma.';
}

function serializeAccountState(
  account: { username: string | null; linkedAt: Date } | null,
): TrainingTelegramAccountState {
  return account
    ? {
        linked: true,
        username: account.username,
        linkedAt: account.linkedAt.toISOString(),
      }
    : { linked: false, username: null, linkedAt: null };
}

async function getTransactionNow(transaction: Prisma.TransactionClient) {
  const [row] = await transaction.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP AS "now"`,
  );

  if (!row) throw new Error('Database timestamp unavailable');
  return row.now;
}
